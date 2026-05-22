import type { BuilderFile } from "../builder";
import type { CheckFinding, CheckRunStatus } from "@workspace/db";

export type PrivacyResult = {
  checkName: "privacy";
  status: CheckRunStatus;
  findings: CheckFinding[];
};

// ─── Tracker pattern library ──────────────────────────────────────────────────

type TrackerPattern = {
  name: string;
  patterns: RegExp[];
};

const TRACKER_PATTERNS: TrackerPattern[] = [
  {
    name: "Google Analytics (gtag.js / GA4)",
    patterns: [
      /googletagmanager\.com\/gtag\/js/i,
      /google-analytics\.com\/analytics\.js/i,
      /google-analytics\.com\/ga\.js/i,
      /gtag\s*\(\s*['"]config['"]/i,
    ],
  },
  {
    name: "Facebook Pixel",
    patterns: [/connect\.facebook\.net\/.*\/fbevents\.js/i, /fbq\s*\(\s*['"]init['"]/i],
  },
  {
    name: "Hotjar",
    patterns: [/static\.hotjar\.com/i, /hotjar\.com\/c\/hotjar/i],
  },
  {
    name: "Intercom",
    patterns: [/widget\.intercom\.io/i, /js\.intercomcdn\.com/i, /Intercom\s*\(/i],
  },
  {
    name: "Mixpanel",
    patterns: [/cdn\.mxpnl\.com/i, /cdn4\.mxpnl\.com/i, /mixpanel\.init\s*\(/i],
  },
  {
    name: "Amplitude",
    patterns: [/cdn\.amplitude\.com/i, /amplitude\.getInstance\s*\(/i, /amplitude\.init\s*\(/i],
  },
  {
    name: "Segment",
    patterns: [/cdn\.segment\.com/i, /analytics\.load\s*\(/i],
  },
  {
    name: "TikTok Pixel",
    patterns: [/analytics\.tiktok\.com/i, /ttq\s*\.\s*load\s*\(/i],
  },
];

// ─── Consent keyword detection ────────────────────────────────────────────────

const CONSENT_PATTERNS: RegExp[] = [
  /cookie[- ]?(consent|banner|notice|policy)/i,
  /gdpr/i,
  /consent\s*\(/i,
  /accept\s*(all\s*)?cookies/i,
  /cookieconsent/i,
  /onetrust/i,
  /cookiebot/i,
];

// ─── Sensitive storage field detection ────────────────────────────────────────

const SENSITIVE_STORAGE_PATTERN =
  /(?:localStorage|sessionStorage)\.setItem\s*\(\s*["'](?:email|name|phone|ssn|card|password|passwd|credit)/gi;

// ─── External fetch / form POST detection ────────────────────────────────────

const EXTERNAL_FETCH_PATTERNS: RegExp[] = [
  /fetch\s*\(\s*['"]https?:\/\/(?!localhost|127\.0\.0\.1)/gi,
  /new\s+XMLHttpRequest[\s\S]{0,200}\.open\s*\(\s*['"][A-Z]+['"]\s*,\s*['"]https?:\/\/(?!localhost|127\.0\.0\.1)/gi,
];

// Matches <form ... action="https://..."> or <form action='https://...'> —
// catches both POST and GET forms submitting to an external domain.
const EXTERNAL_FORM_ACTION_PATTERN =
  /<form\b[^>]*\baction\s*=\s*["']https?:\/\/(?!localhost|127\.0\.0\.1)[^"']*["'][^>]*>/gi;

// ─── Privacy policy link detection ───────────────────────────────────────────

const PRIVACY_LINK_PATTERNS: RegExp[] = [
  /<a\s[^>]*href[^>]*privacy/gi,
  /<a\s[^>]*>[\s\S]{0,40}privacy\s*policy/gi,
  /href=["'][^"']*privacy[^"']*["']/gi,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isHtmlOrJs(file: BuilderFile): boolean {
  return (
    file.mimeType === "text/html" ||
    file.mimeType === "text/javascript" ||
    file.mimeType === "application/javascript" ||
    file.path.endsWith(".html") ||
    file.path.endsWith(".js")
  );
}

function hasConsentMechanism(content: string): boolean {
  return CONSENT_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(content);
  });
}

function hasPrivacyPolicyLink(content: string): boolean {
  return PRIVACY_LINK_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(content);
  });
}

// ─── Main check ───────────────────────────────────────────────────────────────

export function runPrivacyCheck(files: BuilderFile[]): PrivacyResult {
  const findings: CheckFinding[] = [];
  const seen = new Set<string>();

  const htmlJsFiles = files.filter(isHtmlOrJs);
  const allContent = htmlJsFiles.map((f) => f.content).join("\n");

  // ── 1. Tracker detection ───────────────────────────────────────────────────
  const hasConsent = hasConsentMechanism(allContent);

  for (const file of htmlJsFiles) {
    for (const tracker of TRACKER_PATTERNS) {
      const found = tracker.patterns.some((p) => {
        p.lastIndex = 0;
        return p.test(file.content);
      });

      if (!found) continue;

      if (!hasConsent) {
        const key = `${file.path}:0:tracker-no-consent:${tracker.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({
            file: file.path,
            line: undefined,
            message: `Tracker loaded without consent mechanism: ${tracker.name}`,
            detail: `${tracker.name} is loaded but no cookie consent banner or GDPR consent mechanism was detected in the app. Users must be given the option to accept or reject tracking cookies before any tracker scripts run. Add a cookie consent banner and conditionally load tracking scripts only after consent is granted.`,
            severity: "warning",
          });
        }
      }
    }
  }

  // ── 2. External fetch / XHR detection ────────────────────────────────────
  for (const file of htmlJsFiles) {
    for (const pattern of EXTERNAL_FETCH_PATTERNS) {
      pattern.lastIndex = 0;
      const lines = file.content.split("\n");
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx] ?? "";
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          const key = `${file.path}:${lineIdx}:external-fetch`;
          if (!seen.has(key)) {
            seen.add(key);
            findings.push({
              file: file.path,
              line: lineIdx + 1,
              message: "Data sent to external endpoint",
              detail:
                "The app makes a fetch or XHR request to an external (third-party) URL. Ensure this data transfer is disclosed in a privacy policy and that users have consented if the data is personally identifiable (names, emails, IP addresses, etc.).",
              severity: "error",
            });
          }
        }
      }
    }
  }

  // ── 3. External form action detection (HTML files only) ──────────────────
  for (const file of files.filter((f) => f.mimeType === "text/html" || f.path.endsWith(".html"))) {
    EXTERNAL_FORM_ACTION_PATTERN.lastIndex = 0;
    const lines = file.content.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] ?? "";
      EXTERNAL_FORM_ACTION_PATTERN.lastIndex = 0;
      if (EXTERNAL_FORM_ACTION_PATTERN.test(line)) {
        const key = `${file.path}:${lineIdx}:external-form-action`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({
            file: file.path,
            line: lineIdx + 1,
            message: "Form submits data to an external URL",
            detail:
              "A <form> element has an action attribute pointing to an external (third-party) domain. User-entered data will be sent to that domain. Ensure this is disclosed in a privacy policy, that users have consented, and that the destination is a trusted service. If unintentional, change the action to a relative URL on the same origin.",
            severity: "error",
          });
        }
      }
    }
  }

  // ── 4. Sensitive storage detection ────────────────────────────────────────
  for (const file of htmlJsFiles) {
    SENSITIVE_STORAGE_PATTERN.lastIndex = 0;
    const lines = file.content.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] ?? "";
      SENSITIVE_STORAGE_PATTERN.lastIndex = 0;
      if (SENSITIVE_STORAGE_PATTERN.test(line)) {
        const key = `${file.path}:${lineIdx}:sensitive-storage`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({
            file: file.path,
            line: lineIdx + 1,
            message: "Sensitive field stored in browser storage",
            detail:
              "A field with a sensitive name (email, name, phone, password, card, SSN) is being stored in localStorage or sessionStorage. Browser storage is accessible to any JavaScript on the page. Consider whether this data needs to be stored client-side, and if so, disclose it in a privacy policy.",
            severity: "warning",
          });
        }
      }
    }
  }

  // ── 4. Privacy policy link check ─────────────────────────────────────────
  const htmlFiles = files.filter((f) => f.mimeType === "text/html" || f.path.endsWith(".html"));

  if (htmlFiles.length > 0) {
    const htmlContent = htmlFiles.map((f) => f.content).join("\n");
    const hasPrivacyLink = hasPrivacyPolicyLink(htmlContent);

    if (!hasPrivacyLink) {
      findings.push({
        file: htmlFiles[0]?.path ?? "index.html",
        line: undefined,
        message: "No privacy policy link found",
        detail:
          "The app does not appear to link to a privacy policy page. If the app collects any user data (even just analytics), a privacy policy link is required by GDPR, CCPA, and most app store guidelines. Add a link to a privacy policy page in the app's footer or navigation.",
        severity: "info",
      });
    }
  }

  const status: CheckRunStatus =
    findings.length === 0
      ? "pass"
      : findings.some((f) => f.severity === "error")
        ? "fail"
        : findings.some((f) => f.severity === "warning")
          ? "warning"
          : "pass";

  return { checkName: "privacy", status, findings };
}
