export const REFERENCE_IMAGE_IMPLEMENTATION_POLICY =
  "Reproduce the attached reference faithfully, including its layout, structure, styling, colours, spacing, and flow. When several images are attached, first map which image belongs to which page, which navigation and footer elements repeat, and how the pages connect; if that mapping is genuinely ambiguous, ask exactly one focused question before building. Say briefly which details were visible, which backend or permission behaviour you inferred, and which unseen hover, loading, empty, error, or signed-out states you had to design. If a third-party brand name or logo is visible, replace only that brand with the user's own brand when supplied, otherwise a neutral placeholder, and tell the user once in one plain sentence that you did so. Never block, warn, lecture, judge intent, or repeat that note in later turns. Treat imperfect phone photos as valid specifications and preserve their intended composition rather than requiring a polished mockup.";

export type VisualInputIntent = "diagnose" | "match" | "clarify";

const DIAGNOSE_VISUAL_PATTERN =
  /\b(?:diagnos(?:e|is)|debug|error|broken|bug|wrong|failed?|failure|issue|problem|why|what\s+(?:does|is|happened)|explain|read\s+this|not\s+work(?:ing)?|doesn['’]?t\s+work)\b/i;
const MATCH_VISUAL_PATTERN =
  /\b(?:build|create|make|match|copy|reproduce|implement|restyle|redesign|look\s+like|based\s+on|use\s+(?:this|these)\s+as|reference|mockup|design)\b/i;

/**
 * The visual subtype is a closed, deterministic contract. Attachments never
 * silently mean "build": the user's words must establish diagnose or match.
 */
export function classifyVisualInputIntent(userPrompt: string): VisualInputIntent {
  const diagnose = DIAGNOSE_VISUAL_PATTERN.test(userPrompt);
  const match = MATCH_VISUAL_PATTERN.test(userPrompt);
  if (diagnose && !match) return "diagnose";
  if (match && !diagnose) return "match";
  return "clarify";
}

export function visualIntentInstruction(intent: VisualInputIntent): string {
  if (intent === "diagnose") {
    return "VISUAL INTENT: DIAGNOSE. Before doing anything else, tell the user in one plain sentence that you understood the image as something to inspect. Explain only what the pixels support. Do not enter a mutation path unless the user later asks for a change.";
  }
  if (intent === "match") {
    return `VISUAL INTENT: MATCH. Before changing anything, tell the user in one plain sentence that you understood the image as a reference to build or restyle from. Then follow this policy: ${REFERENCE_IMAGE_IMPLEMENTATION_POLICY}`;
  }
  return "VISUAL INTENT: CLARIFY. The user's words do not establish whether the image is evidence to diagnose or a reference to match. Ask exactly one focused question choosing between those two outcomes. Do not mutate, generate, or claim a change before the answer.";
}

export function referenceAwarePrompt(userPrompt: string): string {
  const intent = classifyVisualInputIntent(userPrompt);
  return `${userPrompt}\n\n${visualIntentInstruction(intent)}`;
}
