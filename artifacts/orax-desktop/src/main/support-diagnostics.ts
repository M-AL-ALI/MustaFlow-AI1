import { app } from "electron";
import type {
  AuthSession,
  HostState,
  LocalProject,
  RelayState,
  SupportDiagnostics,
} from "../shared/types";

const ALLOWED_SAFETY_KEYS = new Set([
  "includesSessionToken",
  "includesPasswords",
  "includesEnvironmentVariables",
  "includesLocalProjectPaths",
]);

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(token|secret|password|passwd|api[-_]?key|private[-_]?key|credential|authorization|env|environment)([_-]|$)/i;

const SENSITIVE_VALUE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i },
  { label: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/ },
  { label: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { label: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  {
    label: "environment assignment",
    pattern: /\b[A-Z][A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)=/,
  },
  {
    label: "Windows local path",
    pattern: /\b[A-Za-z]:\\(?:Users|ProgramData|Projects|dev|src|work|repo|repos)\\/i,
  },
  { label: "UNC local path", pattern: /\\\\[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+\\/ },
  {
    label: "Unix local path",
    pattern: /(?:^|\s)\/(?:Users|home|var|tmp|opt|srv|workspace|workspaces)\//,
  },
];

interface BuildSupportDiagnosticsParams {
  session: AuthSession | null;
  hostState: HostState | null;
  relayState: RelayState;
  localProjects: LocalProject[];
}

export function buildSupportDiagnostics({
  session,
  hostState,
  relayState,
  localProjects,
}: BuildSupportDiagnosticsParams): SupportDiagnostics {
  return {
    generatedAt: new Date().toISOString(),
    app: {
      name: "Orax Desktop",
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    },
    auth: {
      signedIn: Boolean(session),
      userId: session?.userId ?? null,
      email: session?.email ?? null,
    },
    host: hostState ? { ...hostState } : null,
    relay: { ...relayState },
    localProjects: {
      count: localProjects.length,
      displayNames: localProjects.map((project) => project.displayName),
    },
    safety: {
      includesSessionToken: false,
      includesPasswords: false,
      includesEnvironmentVariables: false,
      includesLocalProjectPaths: false,
    },
  };
}

function recordViolation(violations: string[], path: string, reason: string): void {
  violations.push(`${path}: ${reason}`);
}

function inspectValue(value: unknown, path: string, violations: string[]): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    for (const { label, pattern } of SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        recordViolation(violations, path, label);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectValue(entry, `${path}[${index}]`, violations));
    return;
  }

  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (!ALLOWED_SAFETY_KEYS.has(key) && SENSITIVE_KEY_PATTERN.test(key)) {
        recordViolation(violations, childPath, "sensitive key");
      }
      inspectValue(entry, childPath, violations);
    }
  }
}

export function findSupportDiagnosticsViolations(diagnostics: SupportDiagnostics): string[] {
  const violations: string[] = [];
  inspectValue(diagnostics, "diagnostics", violations);
  return violations;
}

export function serializeValidatedSupportDiagnostics(diagnostics: SupportDiagnostics): string {
  const violations = findSupportDiagnosticsViolations(diagnostics);
  if (violations.length > 0) {
    throw new Error(`Support diagnostics failed safety validation: ${violations.join("; ")}`);
  }
  return `${JSON.stringify(diagnostics, null, 2)}\n`;
}
