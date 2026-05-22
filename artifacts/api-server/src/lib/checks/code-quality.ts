import type { BuilderFile } from "../builder";
import type { CheckFinding, CheckRunStatus } from "@workspace/db";

export type CodeQualityResult = {
  checkName: "code-quality";
  status: CheckRunStatus;
  findings: CheckFinding[];
};

type QualityRule = {
  pattern: RegExp;
  message: string;
  detail: string;
  severity: "error" | "warning" | "info";
  skipIf?: RegExp;
};

const QUALITY_RULES: QualityRule[] = [
  {
    pattern: /\beval\s*\(/g,
    message: "eval() usage detected",
    detail:
      "eval() is a security risk and a performance issue. Use JSON.parse() for JSON, or restructure the logic to avoid dynamic code evaluation.",
    severity: "error",
  },
  {
    pattern: /document\.write\s*\(/g,
    message: "document.write() usage detected",
    detail:
      "document.write() blocks parsing, can overwrite the entire page after load, and is a common XSS vector. Use DOM manipulation methods (createElement, appendChild, insertAdjacentHTML) instead.",
    severity: "error",
  },
  {
    pattern: /new\s+Function\s*\(/g,
    message: "new Function() usage detected",
    detail:
      "new Function() is equivalent to eval() and carries the same security and performance risks. Refactor to use a regular function or callback instead.",
    severity: "error",
  },
  {
    pattern: /\.innerHTML\s*=\s*(?!["'`]\s*["'`]|["'`]<)/g,
    message: "Potentially unsafe innerHTML assignment",
    detail:
      "Assigning non-literal values to innerHTML can lead to XSS if the value contains user input. Use textContent for plain text, or sanitize HTML with DOMPurify before inserting.",
    severity: "warning",
    skipIf: /\.innerHTML\s*=\s*["'`][^${]*["'`]/,
  },
  {
    pattern: /console\.(log|debug|info)\s*\(/g,
    message: "console.log/debug/info left in production code",
    detail:
      "Debug console statements should be removed before shipping. Use a proper logging strategy (e.g. log only on error, or gate behind a debug flag).",
    severity: "info",
  },
  {
    pattern: /XMLHttpRequest\s*\(\)[\s\S]{0,200}\.open\s*\([^,]+,\s*[^,]+,\s*false\)/g,
    message: "Synchronous XMLHttpRequest usage",
    detail:
      "Synchronous XHR blocks the main thread and degrades UX. Use the Fetch API with async/await instead.",
    severity: "error",
  },
  {
    pattern: /setTimeout\s*\(\s*["'][^"']+["']/g,
    message: "setTimeout with string argument (implicit eval)",
    detail:
      "Passing a string to setTimeout is equivalent to eval(). Pass a function reference instead: setTimeout(() => { ... }, delay).",
    severity: "warning",
  },
];

const JS_MIME_TYPES = new Set(["text/javascript", "application/javascript", "text/html"]);

function isJsOrHtml(file: BuilderFile): boolean {
  return (
    JS_MIME_TYPES.has(file.mimeType) || file.path.endsWith(".html") || file.path.endsWith(".js")
  );
}

export function runCodeQualityCheck(files: BuilderFile[]): CodeQualityResult {
  const findings: CheckFinding[] = [];

  for (const file of files) {
    if (!isJsOrHtml(file)) continue;
    const lines = file.content.split("\n");

    for (const rule of QUALITY_RULES) {
      rule.pattern.lastIndex = 0;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx] ?? "";
        if (rule.skipIf && rule.skipIf.test(line)) continue;

        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(line)) {
          findings.push({
            file: file.path,
            line: lineIdx + 1,
            message: rule.message,
            detail: rule.detail,
            severity: rule.severity,
          });
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
        : findings.some((f) => f.severity === "warning")
          ? "warning"
          : "pass";

  return { checkName: "code-quality", status, findings };
}
