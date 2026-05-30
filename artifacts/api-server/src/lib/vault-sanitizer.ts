// ─────────────────────────────────────────────────────────────────────────────
// Shared vault content sanitizer.
// Used by both the vault route (before storing) and the embedding service
// (before sending content to the embedding model).
//
// Never store or embed API keys, tokens, secrets, or internal references.
// ─────────────────────────────────────────────────────────────────────────────

const BANNED_PATTERNS: RegExp[] = [
  /\bsk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9]{20,}/gi, // OpenAI / Anthropic keys
  /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi, // Bearer tokens
  /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g, // JWTs
  /postgresql:\/\/[^\s"']+/gi, // DB connection strings
  /postgres:\/\/[^\s"']+/gi,
  /[A-Za-z0-9+/]{40,}={0,2}/g, // Long base64 blobs (≥ 40 chars)
];

const BANNED_KEY_SUBSTRINGS = [
  "sessiontoken",
  "handofftoken",
  "builderid",
  "containerid",
  "neonproject",
  "flymachine",
  "fileref",
  "imageref",
  "datasetref",
  "api_key",
  "apikey",
  "secret",
  "password",
  "credential",
];

/**
 * Returns a human-readable reason string if the text contains potentially
 * sensitive content, or null if it is clean.
 */
export function detectSensitiveContent(text: string): string | null {
  for (const pattern of BANNED_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return "Potential credential or token detected";
    }
  }
  const lower = text.toLowerCase();
  for (const kw of BANNED_KEY_SUBSTRINGS) {
    if (lower.includes(kw + "=") || lower.includes(kw + ":") || lower.includes(kw + '"')) {
      return `Sensitive field detected: "${kw}"`;
    }
  }
  return null;
}

/**
 * Replace any matched banned patterns with "[REDACTED]".
 * Does not strip BANNED_KEY_SUBSTRING matches because they are partial-string
 * checks only used for detection, not extraction.
 */
export function sanitizeText(text: string): string {
  let out = text;
  for (const pattern of BANNED_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
