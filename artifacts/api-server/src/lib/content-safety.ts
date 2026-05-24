/**
 * Content safety scanner — Task #560
 *
 * Lightweight, locally maintained scan of published HTML/JS content for:
 *   1. Phishing patterns: credential-harvesting keywords + fake login indicators.
 *   2. Known malware infrastructure: C2 URLs, payload-drop patterns.
 *
 * Design principles:
 *   - No external API calls — runs entirely in-process, zero latency overhead.
 *   - Low false-positive rate: patterns are high-confidence indicators, not broad keywords.
 *   - Admin can override a failed scan (overrideSafetyCheck flag on publish).
 *
 * Returns a ScanResult with ok=true (safe) or ok=false (blocked) plus a list of violations.
 */

export interface SafetyScanViolation {
  pattern: string;
  context: string;
  severity: "block" | "warn";
}

export interface SafetyScanResult {
  ok: boolean;
  violations: SafetyScanViolation[];
  scannedFiles: number;
}

// ── Phishing patterns ─────────────────────────────────────────────────────────
// Each entry: [patternLabel, RegExp, severity]
// These are high-confidence indicators of credential-harvesting pages.
const PHISHING_PATTERNS: Array<[string, RegExp, "block" | "warn"]> = [
  // Credential form targeting major platforms with urgent language
  ["paypal-phish", /paypal\.com(?!\.)/i, "warn"],
  ["apple-id-phish", /appleid\.apple\.com(?!\.)/i, "warn"],
  ["microsoft-phish", /login\.microsoftonline\.com(?!\.)/i, "warn"],
  ["google-phish", /accounts\.google\.com(?!\.)/i, "warn"],
  ["amazon-phish", /amazon\.com\/ap\/signin(?!\.)/i, "warn"],
  // Fake urgency patterns combined with form submission
  [
    "credential-harvest-form",
    /(?:verify|confirm|update|secure)\s+(?:your\s+)?(?:account|password|credit\s*card|ssn|social\s+security)/i,
    "warn",
  ],
  // Hidden iframe pointing to off-domain URL (common phishing technique)
  [
    "hidden-offsite-iframe",
    /<iframe[^>]+(?:display:\s*none|visibility:\s*hidden)[^>]*src=["'][^"']*https?:\/\/(?!(?:cdn\.|static\.))/i,
    "warn",
  ],
  // Base64-encoded suspicious strings (data: URI with executable content)
  [
    "base64-exec-payload",
    /data:(?:text\/html|application\/javascript|text\/javascript);base64,[A-Za-z0-9+/]{200,}/i,
    "block",
  ],
  // eval of externally-fetched content (code injection pattern)
  ["eval-fetch-exec", /eval\s*\(\s*(?:await\s+)?fetch\s*\(/i, "block"],
  // document.write with external script injection
  ["document-write-script", /document\.write\s*\(\s*['"]<script[^'"]*src\s*=/i, "block"],
];

// ── Malware / C2 patterns ─────────────────────────────────────────────────────
// Commonly abused free hosting / paste platforms used to drop payloads.
const MALWARE_PATTERNS: Array<[string, RegExp, "block" | "warn"]> = [
  // Known payload-drop URL patterns (common in malvertising)
  ["pastebin-exec", /pastebin\.com\/raw\//i, "warn"],
  [
    "raw-github-exec",
    /raw\.githubusercontent\.com\/[^"'\s]+\.(?:exe|bat|ps1|sh|vbs|cmd)/i,
    "block",
  ],
  // Skimmers: card data exfil patterns
  [
    "card-skimmer-exfil",
    /(?:cc_?num|card_?number|cvv|exp_?(?:iry|date))\s*[=:]\s*(?:document|window|form)/i,
    "block",
  ],
  [
    "navigator-sendbeacon-exfil",
    /navigator\.sendBeacon\s*\([^)]*(?:cc|card|cvv|ssn|password)/i,
    "block",
  ],
  // Cryptominer patterns
  ["cryptominer-coinhive", /coinhive\.com|coin-hive\.com|cryptoloot\.pro/i, "block"],
  ["cryptominer-generic", /(?:CoinHive|Monero|CryptoNight)\s*\.\s*Anonymous/i, "block"],
  // Common malware dropper patterns
  ["powershell-dropper", /(?:powershell|cmd\.exe|mshta\.exe)/i, "warn"],
  ["wscript-dropper", /WScript\.Shell|ActiveXObject\s*\(\s*["']WScript/i, "block"],
];

const ALL_PATTERNS = [...PHISHING_PATTERNS, ...MALWARE_PATTERNS];

// Snippet extraction: returns a short context string around the match (for logging)
function extractContext(content: string, matchIndex: number, contextLen = 80): string {
  const start = Math.max(0, matchIndex - 20);
  const end = Math.min(content.length, matchIndex + contextLen);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

type SnapshotFile = { path: string; content: string; mimeType?: string };

/**
 * Scan a set of project files for phishing / malware patterns.
 * Only scans text files (HTML, JS, CSS) — skips binary content.
 */
export function scanContent(files: SnapshotFile[]): SafetyScanResult {
  const violations: SafetyScanViolation[] = [];
  let scanned = 0;

  for (const file of files) {
    const mime = file.mimeType ?? "";
    const isText =
      mime.startsWith("text/") ||
      mime === "application/javascript" ||
      mime === "application/typescript" ||
      file.path.endsWith(".html") ||
      file.path.endsWith(".htm") ||
      file.path.endsWith(".js") ||
      file.path.endsWith(".ts") ||
      file.path.endsWith(".css");

    if (!isText) continue;
    // Skip very large files (> 2MB) — they're unlikely to be hand-crafted phishing pages
    if (file.content.length > 2 * 1024 * 1024) continue;

    scanned++;
    const content = file.content;

    for (const [label, pattern, severity] of ALL_PATTERNS) {
      const match = pattern.exec(content);
      if (match) {
        violations.push({
          pattern: label,
          context: extractContext(content, match.index),
          severity,
        });
        // Don't add multiple violations for the same pattern in the same file
      }
    }
  }

  const hasBlock = violations.some((v) => v.severity === "block");
  return {
    ok: !hasBlock,
    violations,
    scannedFiles: scanned,
  };
}
