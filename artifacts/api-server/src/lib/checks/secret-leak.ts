import type { BuilderFile } from "../builder";
import type { CheckFinding, CheckRunStatus } from "@workspace/db";

export type SecretLeakResult = {
  checkName: "secret-leak";
  status: CheckRunStatus;
  findings: CheckFinding[];
};

const SECRET_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
  severity: "error" | "warning";
}> = [
  {
    // eslint-disable-next-line no-useless-escape
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["']([A-Za-z0-9_\-]{20,})["']/gi,
    label: "API key",
    severity: "error",
  },
  {
    pattern:
      /(?:secret|token|password|passwd|pwd)\s*[:=]\s*["']([A-Za-z0-9_\-@#$%^&*!]{10,})["']/gi,
    label: "Secret/token/password",
    severity: "error",
  },
  {
    pattern: /sk[-_][A-Za-z0-9]{20,}/g,
    label: "OpenAI/Stripe secret key",
    severity: "error",
  },
  {
    pattern: /pk[-_](live|test)[-_][A-Za-z0-9]{20,}/gi,
    label: "Stripe publishable key",
    severity: "error",
  },
  {
    pattern: /AAAA[A-Za-z0-9+/]{30,}/g,
    label: "Firebase/GCM server key",
    severity: "error",
  },
  {
    pattern: /ghp_[A-Za-z0-9]{30,}/g,
    label: "GitHub personal access token",
    severity: "error",
  },
  {
    // eslint-disable-next-line no-useless-escape
    pattern: /xox[baprs]-[A-Za-z0-9\-]{10,}/gi,
    label: "Slack token",
    severity: "error",
  },
  {
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
    label: "Google API key",
    severity: "error",
  },
  {
    pattern: /(?:access[_-]?key[_-]?id)\s*[:=]\s*["']([A-Z0-9]{16,})["']/gi,
    label: "AWS access key ID",
    severity: "error",
  },
  {
    pattern: /(?:bearer)\s+([A-Za-z0-9\-._~+/]{40,})/gi,
    label: "Bearer token",
    severity: "warning",
  },
];

const PLACEHOLDER_EXEMPTIONS = [
  /your[-_]?api[-_]?key/i,
  /your[-_]?token/i,
  /placeholder/i,
  /XXXX/i,
  /\*{4,}/,
  /from\s+project\s+secrets/i,
  /process\.env\./i,
  /import\.meta\.env\./i,
  /\$\{/,
];

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_EXEMPTIONS.some((p) => p.test(value));
}

function maskValue(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

export function runSecretLeakCheck(files: BuilderFile[]): SecretLeakResult {
  const findings: CheckFinding[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] ?? "";
      if (isPlaceholder(line)) continue;

      for (const { pattern, label, severity } of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          const captured = match[1] ?? match[0] ?? "";
          if (isPlaceholder(captured)) continue;
          findings.push({
            file: file.path,
            line: lineIdx + 1,
            message: `${label} detected: ${maskValue(captured)}`,
            detail: `A hardcoded ${label.toLowerCase()} was found on line ${lineIdx + 1}. Move this to project secrets and reference it via a placeholder comment or environment variable.`,
            severity,
          });
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

  return { checkName: "secret-leak", status, findings };
}
