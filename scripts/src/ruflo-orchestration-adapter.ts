import { RUFLO_MCP_POLICY_VERSION, RUFLO_PINNED_VERSION } from "./ruflo-mcp-policy";
import type { RufloToolTransport } from "./ruflo-mcp-client";

type Risk = "low" | "medium" | "high" | "critical";

export interface RufloReviewSubject {
  baseRef: string;
  headCommit: string;
  headTree: string;
}

export interface RufloReviewReceipt {
  schemaVersion: 1;
  provider: "ruflo";
  providerVersion: typeof RUFLO_PINNED_VERSION;
  policy: typeof RUFLO_MCP_POLICY_VERSION;
  subject: RufloReviewSubject;
  assessment: {
    risk: Risk;
    riskScore: number;
    classification: string;
    totalFiles: number;
    totalAdditions: number;
    totalDeletions: number;
  };
  evidence: {
    tools: ["analyze_diff-risk", "analyze_diff-classify", "analyze_diff-stats"];
    noMutationAuthority: true;
  };
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function integer(value: unknown, code: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
}

export class RufloReadOnlyReviewAdapter {
  constructor(private readonly transport: RufloToolTransport) {}

  async review(subject: RufloReviewSubject): Promise<RufloReviewReceipt> {
    if (!/^[0-9a-f]{40}$/u.test(subject.headCommit) || !/^[0-9a-f]{40}$/u.test(subject.headTree)) {
      throw new Error("ruflo_review_subject_invalid");
    }

    const [riskRaw, classificationRaw, statsRaw] = await Promise.all([
      this.transport.callTool("analyze_diff-risk", { ref: subject.baseRef }),
      this.transport.callTool("analyze_diff-classify", { ref: subject.baseRef }),
      this.transport.callTool("analyze_diff-stats", { ref: subject.baseRef }),
    ]);
    const risk = object(riskRaw, "ruflo_review_risk_invalid");
    const classification = object(classificationRaw, "ruflo_review_classification_invalid");
    const stats = object(statsRaw, "ruflo_review_stats_invalid");
    const riskObject = object(risk.risk, "ruflo_review_risk_invalid");
    const overall = riskObject.overall;
    if (!(["low", "medium", "high", "critical"] as unknown[]).includes(overall)) {
      throw new Error("ruflo_review_risk_invalid");
    }
    const classificationObject = object(
      classification.classification,
      "ruflo_review_classification_invalid",
    );
    if (typeof classificationObject.primary !== "string") {
      throw new Error("ruflo_review_classification_invalid");
    }

    return {
      schemaVersion: 1,
      provider: "ruflo",
      providerVersion: RUFLO_PINNED_VERSION,
      policy: RUFLO_MCP_POLICY_VERSION,
      subject,
      assessment: {
        risk: overall as Risk,
        riskScore: integer(riskObject.score, "ruflo_review_risk_invalid"),
        classification: classificationObject.primary,
        totalFiles: integer(stats.totalFiles, "ruflo_review_stats_invalid"),
        totalAdditions: integer(stats.totalAdditions, "ruflo_review_stats_invalid"),
        totalDeletions: integer(stats.totalDeletions, "ruflo_review_stats_invalid"),
      },
      evidence: {
        tools: ["analyze_diff-risk", "analyze_diff-classify", "analyze_diff-stats"],
        noMutationAuthority: true,
      },
    };
  }
}
