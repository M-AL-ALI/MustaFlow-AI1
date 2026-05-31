/**
 * Image generation safety validator — Phase 9A-1.
 *
 * Pattern-based pre-generation safety check. No AI round-trip required —
 * this runs synchronously before credits are deducted or the provider is called.
 *
 * ISOLATION: this file MUST NOT import from builder.ts or any pipeline module.
 */

export type SafetyCategory =
  | "violence"
  | "adult"
  | "hate_speech"
  | "self_harm"
  | "illegal_activity"
  | "personal_information"
  | "misinformation";

export interface SafetyResult {
  safe: boolean;
  category?: SafetyCategory;
  reason?: string;
}

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; category: SafetyCategory; reason: string }> = [
  {
    pattern:
      /\b(gore|decapitat|disembowel|mutilat|torture|snuff|graphic\s+violence|blood\s+bath|mass\s+murder|massacre\s+graphic)\b/i,
    category: "violence",
    reason: "Graphic violence is not allowed",
  },
  {
    pattern:
      /\b(nude|naked|nudity|porn|pornograph|explicit\s+sex|hentai|onlyfans|nsfw|genitals?|uncensored\s+body)\b/i,
    category: "adult",
    reason: "Explicit adult content is not allowed",
  },
  {
    pattern:
      /\b(racial\s+slur|n[\-\s]*word|k[\-\s]*k[\-\s]*k|white\s+suprema|nazi\s+propaganda|antisemit|islamophob|homophob\s+slur)\b/i,
    category: "hate_speech",
    reason: "Hate speech and discriminatory content is not allowed",
  },
  {
    pattern:
      /\b(suicide\s+method|self[\-\s]harm\s+instruction|how\s+to\s+cut|self[\-\s]mutilat)\b/i,
    category: "self_harm",
    reason: "Content promoting self-harm is not allowed",
  },
  {
    pattern:
      /\b(how\s+to\s+make\s+(?:bomb|explosive|weapon)|drug\s+manufactur|meth\s+cook|synthesize\s+(?:drugs?|poison))\b/i,
    category: "illegal_activity",
    reason: "Instructions for illegal activities are not allowed",
  },
  {
    pattern:
      /\b(social\s+security\s+number|credit\s+card\s+number|passport\s+number|bank\s+account\s+number)\b/i,
    category: "personal_information",
    reason: "Requests involving personal financial data are not allowed",
  },
  {
    pattern:
      /\b(deepfake\s+of|fake\s+photo\s+of\s+(?:real|actual)\s+person|realistic\s+face\s+of\s+(?:celebrity|politician|president))\b/i,
    category: "misinformation",
    reason: "Deepfakes of real individuals are not allowed",
  },
  {
    // Brand impersonation: official-looking replicas of major brand logos / trademarks
    pattern:
      /\b(?:official|authentic|real|exact|replica\s+of)\s+(?:apple|google|microsoft|amazon|meta|facebook|instagram|twitter|x\.com|nike|adidas|coca[\-\s]cola|pepsi|mcdonald|starbucks|visa|mastercard|paypal|stripe|openai|anthropic)\s+(?:logo|seal|badge|trademark|brand|identity)\b|\b(?:apple|google|microsoft|amazon|meta|facebook|instagram|twitter|nike|adidas|coca[\-\s]cola|pepsi|mcdonald|starbucks|visa|mastercard|paypal)\s+(?:logo\s+(?:replica|copy|clone|duplicate|forgery)|counterfeit\s+(?:logo|seal))\b/i,
    category: "misinformation",
    reason: "Replicas of official brand logos and trademarks are not allowed",
  },
  {
    // Impersonation of officials / government documents
    pattern:
      /\b(?:fake|forged?|counterfeit|replica)\s+(?:passport|id\s+card|driver['']?s?\s+licen[cs]e|government\s+(?:id|document|seal|badge)|police\s+(?:badge|id|shield)|military\s+(?:id|badge|rank|insignia)|official\s+seal|notary\s+seal)\b|\b(?:photograph\s+of|headshot\s+of|portrait\s+of)\s+(?:as\s+(?:a\s+)?(?:police|officer|detective|federal\s+agent|soldier|judge|official)|impersonat)\b/i,
    category: "misinformation",
    reason: "Forgeries of government documents and impersonation of officials are not allowed",
  },
  {
    // Medical / legal deception: fake prescriptions, certificates, legal documents
    pattern:
      /\b(?:fake|forged?|counterfeit|realistic|replica\s+of)\s+(?:prescription|medical\s+(?:certificate|record|report|note|prescription)|pharmacy\s+label|drug\s+label|lab\s+(?:result|report)|doctor['']?s?\s+(?:note|letter)|dental\s+record|health\s+certificate|legal\s+document|court\s+order|law\s+firm\s+letterhead|attorney\s+(?:seal|letterhead)|notarized\s+document|certificate\s+of\s+(?:authenticity|incorporation|birth|death)|diploma|degree\s+certificate|academic\s+transcript)\b/i,
    category: "misinformation",
    reason: "Forged medical or legal documents are not allowed",
  },
];

const MINIMUM_PROMPT_LENGTH = 3;
const MAXIMUM_PROMPT_LENGTH = 4000;

export function validateImagePrompt(prompt: string): SafetyResult {
  const trimmed = prompt.trim();

  if (trimmed.length < MINIMUM_PROMPT_LENGTH) {
    return { safe: false, category: "misinformation", reason: "Prompt is too short" };
  }

  if (trimmed.length > MAXIMUM_PROMPT_LENGTH) {
    return {
      safe: false,
      category: "misinformation",
      reason: `Prompt exceeds maximum length of ${MAXIMUM_PROMPT_LENGTH} characters`,
    };
  }

  for (const { pattern, category, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: false, category, reason };
    }
  }

  return { safe: true };
}
