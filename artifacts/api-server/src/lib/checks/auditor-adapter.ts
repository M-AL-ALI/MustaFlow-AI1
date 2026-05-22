/**
 * Adapters that run the existing auditor checks and return them
 * as CheckFinding[] for the unified check_runs system.
 */
import type { BuilderFile } from "../builder";
import type { CheckFinding, CheckRunStatus } from "@workspace/db";
import {
  auditAccessibility,
  auditSeo,
  auditPerformance,
  auditCdnVulnerabilities,
  type AuditFinding,
} from "../auditor";

type AuditorCheckName = "accessibility" | "seo" | "performance" | "cdn-security";

type AuditorCheckResult = {
  checkName: AuditorCheckName;
  status: CheckRunStatus;
  findings: CheckFinding[];
};

function auditFindingToCheckFinding(f: AuditFinding): CheckFinding {
  return {
    file: f.file,
    message: f.message,
    detail: f.suggestion,
    severity: f.severity,
  };
}

function statusFromFindings(findings: CheckFinding[]): CheckRunStatus {
  if (findings.length === 0) return "pass";
  if (findings.some((f) => f.severity === "error")) return "fail";
  if (findings.some((f) => f.severity === "warning")) return "warning";
  return "pass";
}

export function runAccessibilityCheck(files: BuilderFile[]): AuditorCheckResult {
  const rawFindings = auditAccessibility(files);
  const findings = rawFindings.map(auditFindingToCheckFinding);
  return { checkName: "accessibility", status: statusFromFindings(findings), findings };
}

export function runSeoCheck(files: BuilderFile[]): AuditorCheckResult {
  const rawFindings = auditSeo(files);
  const findings = rawFindings.map(auditFindingToCheckFinding);
  return { checkName: "seo", status: statusFromFindings(findings), findings };
}

export function runPerformanceCheck(files: BuilderFile[]): AuditorCheckResult {
  const rawFindings = auditPerformance(files);
  const findings = rawFindings.map(auditFindingToCheckFinding);
  return { checkName: "performance", status: statusFromFindings(findings), findings };
}

export function runCdnSecurityCheck(files: BuilderFile[]): AuditorCheckResult {
  const rawFindings = auditCdnVulnerabilities(files);
  const findings = rawFindings.map(auditFindingToCheckFinding);
  return { checkName: "cdn-security", status: statusFromFindings(findings), findings };
}
