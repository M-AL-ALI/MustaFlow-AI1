export const ZERO_PROJECT_CHOICE_CAPTURE_MAX_MESSAGE_CHARS = 20_000;

export type ZeroProjectChoiceCapture = {
  kind: "decision" | "rejection";
  text: string;
};

const CAPTURE_PATTERN =
  /save this as (?:a )?project (decision|rejection)\s*:\s*([^\n.!?]+[.!?]?)/giu;
const NO_MUTATION_REMAINDER =
  /^(?:please\s+)?(?:do\s+not|don't|never)\s+(?:build|change|modify|edit|write)(?:\s+or\s+(?:build|change|modify|edit|write))?\s*(?:the\s+)?(?:project|files?)?$/i;

function normalizeCaptureText(value: string): string | null {
  const normalized = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
  return normalized || null;
}

/**
 * Parse the explicit project-choice syntax shared by the client router and
 * the server-side project memory loader. The parser is bounded and contains
 * no inference: only the two visible user tags are accepted.
 */
export function parseZeroProjectChoiceCaptures(message: string): ZeroProjectChoiceCapture[] {
  if (message.length > ZERO_PROJECT_CHOICE_CAPTURE_MAX_MESSAGE_CHARS) return [];
  const captures: ZeroProjectChoiceCapture[] = [];
  CAPTURE_PATTERN.lastIndex = 0;
  for (const match of message.matchAll(CAPTURE_PATTERN)) {
    const text = normalizeCaptureText(match[2] ?? "");
    if (!text) continue;
    captures.push({
      kind: match[1]?.toLowerCase() === "decision" ? "decision" : "rejection",
      text,
    });
  }
  return captures;
}

/**
 * True only when the whole message is made of explicit project-choice
 * captures plus an optional no-mutation instruction. A mixed request such as
 * "save this decision, then change the header" remains for the authoritative
 * classifier instead of being silently downgraded to an answer.
 */
export function isZeroProjectChoiceCaptureOnlyMessage(message: string): boolean {
  if (parseZeroProjectChoiceCaptures(message).length === 0) return false;
  CAPTURE_PATTERN.lastIndex = 0;
  const remainder = message
    .replace(CAPTURE_PATTERN, " ")
    .replace(/[.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return remainder.length === 0 || NO_MUTATION_REMAINDER.test(remainder);
}
