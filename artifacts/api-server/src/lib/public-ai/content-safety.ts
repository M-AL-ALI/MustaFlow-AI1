/**
 * Lightweight content safety scan for Ora Phase 2.
 *
 * This is a deterministic, regex-based first-pass filter. It blocks obvious
 * unsafe patterns — malware source code signatures, prompt injection attempts
 * inside documents, and categories of clearly harmful content.
 *
 * It is NOT a full content moderation guarantee. It is a safety layer that
 * catches common abuse patterns before extracted text reaches the model.
 *
 * Extracted text is never logged by this module.
 */

interface SafetyResult {
  safe: boolean;
  reason?: string;
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|prompts?|context|system)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /pretend\s+(you\s+are|to\s+be|that\s+you)/i,
  /act\s+as\s+(if\s+you\s+are|a|an)\s+/i,
  /jailbreak/i,
  /bypass\s+(your\s+)?(safety|filter|restriction|guideline)/i,
  /override\s+(your\s+)?(system\s+prompt|instructions?)/i,
  /forget\s+(your\s+)?(previous\s+)?(instructions?|training|guidelines)/i,
  /you\s+have\s+no\s+restrictions?/i,
  /disregard\s+(your\s+)?(previous\s+)?(instructions?|context)/i,
  /<\|im_start\|>/i,
  /###\s*(system|instruction)/i,
];

const MALWARE_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+(\/|~|\*)/i,
  /format\s+c:/i,
  /del\s+\/[sq]/i,
  /wget\s+.+\|\s*(bash|sh|python)/i,
  /curl\s+.+\|\s*(bash|sh|python)/i,
  /powershell\s+-[eE]ncodedCommand/i,
  /\bsystem\s*\(\s*["']rm\b/i,
  /\bos\.system\s*\(/i,
  /\beval\s*\(\s*base64_decode/i,
];

export function scanContent(text: string): SafetyResult {
  const sample = text.slice(0, 50_000);

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sample)) {
      return { safe: false, reason: "prompt-injection" };
    }
  }

  for (const pattern of MALWARE_PATTERNS) {
    if (pattern.test(sample)) {
      return { safe: false, reason: "malware-pattern" };
    }
  }

  return { safe: true };
}
