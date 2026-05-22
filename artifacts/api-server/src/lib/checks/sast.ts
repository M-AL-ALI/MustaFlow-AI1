import type { BuilderFile } from "../builder";
import type { CheckFinding, CheckRunStatus } from "@workspace/db";

export type SastResult = {
  checkName: "sast";
  status: CheckRunStatus;
  findings: CheckFinding[];
};

type SastRule = {
  pattern: RegExp;
  message: string;
  detail: string;
  severity: "error" | "warning" | "info";
};

const SAST_RULES: SastRule[] = [
  {
    pattern:
      /\.innerHTML\s*[+]?=\s*.*(?:user|input|param|query|location\.|search|hash|req\.|request\.)/gi,
    message: "Potential XSS: innerHTML set with user-controlled data",
    detail:
      "Setting innerHTML from user-supplied data (URL params, form input, API response) allows script injection. Use textContent for plain text, or sanitize with DOMPurify before inserting HTML.",
    severity: "error",
  },
  {
    pattern: /document\.write\s*\(.*(?:location\.|search|hash|param|input|user)/gi,
    message: "Potential XSS: document.write with user-controlled data",
    detail:
      "document.write with user-controlled data is a critical XSS vulnerability. Never use document.write; manipulate the DOM via safe APIs instead.",
    severity: "error",
  },
  {
    pattern: /localStorage\.setItem\s*\(["'](?:token|auth|password|secret|key|credential)['"]/gi,
    message: "Sensitive data stored in localStorage",
    detail:
      "Auth tokens, passwords, and secrets stored in localStorage are accessible to any JavaScript on the page, including injected XSS scripts. Use httpOnly cookies for session tokens.",
    severity: "warning",
  },
  {
    pattern: /sessionStorage\.setItem\s*\(["'](?:token|auth|password|secret|key|credential)['"]/gi,
    message: "Sensitive data stored in sessionStorage",
    detail:
      "sessionStorage is accessible to any same-origin script. Prefer httpOnly cookies for authentication tokens.",
    severity: "warning",
  },
  {
    pattern: /__proto__\s*\[|Object\.prototype\s*\[|\["__proto__"\]/g,
    message: "Potential prototype pollution",
    detail:
      "Assigning to __proto__ or Object.prototype properties can pollute the prototype chain for all objects, leading to unexpected behavior and potential security issues. Validate and sanitize object keys before assignment.",
    severity: "error",
  },
  {
    pattern: /Object\.assign\s*\(\s*(?:\w+\.prototype|Object\.prototype)/g,
    message: "Prototype assignment via Object.assign",
    detail:
      "Object.assign to a prototype object can cause prototype pollution. Use Object.create(null) for dictionaries or validate keys before merging.",
    severity: "warning",
  },
  {
    pattern:
      /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)[:/]/g,
    message: "Hardcoded internal/localhost URL",
    detail:
      "Internal network addresses or localhost URLs hardcoded in generated code will fail in production. Use environment variables or configuration to supply the API base URL.",
    severity: "warning",
  },
  {
    pattern: /\.src\s*=\s*.*(?:user|input|param|location\.|search|hash)/gi,
    message: "Potential open redirect or script injection via src assignment",
    detail:
      "Setting element.src from user-controlled data can lead to script injection (for <script>) or open redirects (for iframes). Validate and allowlist URLs before assignment.",
    severity: "warning",
  },
];

function isJsOrHtml(file: BuilderFile): boolean {
  return (
    file.mimeType === "text/html" ||
    file.mimeType === "text/javascript" ||
    file.mimeType === "application/javascript" ||
    file.path.endsWith(".html") ||
    file.path.endsWith(".js")
  );
}

export function runSastCheck(files: BuilderFile[]): SastResult {
  const findings: CheckFinding[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!isJsOrHtml(file)) continue;
    const lines = file.content.split("\n");

    for (const rule of SAST_RULES) {
      rule.pattern.lastIndex = 0;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx] ?? "";
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(line)) {
          const key = `${file.path}:${lineIdx}:${rule.message}`;
          if (!seen.has(key)) {
            seen.add(key);
            findings.push({
              file: file.path,
              line: lineIdx + 1,
              message: rule.message,
              detail: rule.detail,
              severity: rule.severity,
            });
          }
          rule.pattern.lastIndex = 0;
        }
      }
    }
  }

  const status: CheckRunStatus =
    findings.length === 0
      ? "pass"
      : findings.some((f) => f.severity === "error")
        ? "fail"
        : "warning";

  return { checkName: "sast", status, findings };
}
