export type OraResponseQualityScenario =
  | "general"
  | "pasted_report"
  | "pasted_error_log"
  | "direct_tool_reply"
  | "file_generation"
  | "image_generation"
  | "memory_recall";

export type OraResponseQualitySeverity = "warning" | "error";

export interface OraResponseQualityIssue {
  code: string;
  severity: OraResponseQualitySeverity;
  message: string;
}

export interface OraResponseQualityInput {
  scenario?: OraResponseQualityScenario;
  userMessage: string;
  reply: string;
  fileName?: string;
  fileData?: string;
  mimeType?: string;
  imageUrl?: string;
  memoriesUsed?: Array<{ id: number; title: string }>;
  memorySaveCandidate?: string;
  suggestions?: string[];
  signedIn?: boolean;
}

export interface OraResponseQualityResult {
  score: number;
  passed: boolean;
  issues: OraResponseQualityIssue[];
}

const GENERIC_OPENERS = [
  /\b(i can help|i'd be happy to help|sure[,! ]|absolutely[,! ]|here are some suggestions)\b/i,
  /\b(as an ai|as a language model)\b/i,
];

const RAW_PROVIDER_ERROR_PATTERNS = [
  /\b(insufficient balance|invalid api key|api[_ -]?key|rate_limit_exceeded)\b/i,
  /\b(stack trace|traceback|unhandled rejection)\b/i,
  /\b(model error|provider error|upstream error|openai error|anthropic error|gemini error|deepseek error)\b/i,
  /\[object Object\]/i,
];

const ARTIFACT_CLAIM_PATTERNS = [
  /\b(i created|i generated|i made|your file is ready|download the file|attached file)\b/i,
  /\b(here'?s the (xlsx|csv|docx|pdf|pptx|spreadsheet|document|presentation))\b/i,
];

function addIssue(
  issues: OraResponseQualityIssue[],
  code: string,
  severity: OraResponseQualitySeverity,
  message: string,
) {
  issues.push({ code, severity, message });
}

function startsWithDirectSubstance(reply: string): boolean {
  const firstChunk = reply.trim().slice(0, 220);
  if (!firstChunk) return false;
  return !GENERIC_OPENERS.some((pattern) => pattern.test(firstChunk));
}

function mentionsAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

function claimsGeneratedArtifact(reply: string): boolean {
  return ARTIFACT_CLAIM_PATTERNS.some((pattern) => pattern.test(reply));
}

function hasGeneratedFile(input: OraResponseQualityInput): boolean {
  return Boolean(input.fileName && input.fileData && input.mimeType);
}

function scoreIssues(issues: OraResponseQualityIssue[]): number {
  const penalty = issues.reduce((total, issue) => {
    return total + (issue.severity === "error" ? 25 : 10);
  }, 0);
  return Math.max(0, 100 - penalty);
}

export function evaluateOraResponseQuality(
  input: OraResponseQualityInput,
): OraResponseQualityResult {
  const scenario = input.scenario ?? "general";
  const reply = input.reply.trim();
  const issues: OraResponseQualityIssue[] = [];

  if (!reply) {
    addIssue(issues, "empty_reply", "error", "Ora returned an empty visible reply.");
    return { score: 0, passed: false, issues };
  }

  if (reply.length < 12) {
    addIssue(issues, "too_short", "warning", "Ora reply is too short to be useful.");
  }

  if (RAW_PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(reply))) {
    addIssue(
      issues,
      "raw_provider_error",
      "error",
      "Ora exposed a raw provider/system error in the user-facing reply.",
    );
  }

  if (
    scenario === "pasted_report" ||
    scenario === "pasted_error_log" ||
    scenario === "direct_tool_reply"
  ) {
    if (!startsWithDirectSubstance(reply)) {
      addIssue(
        issues,
        "not_direct",
        "warning",
        "Ora did not start with the direct diagnosis or recommendation.",
      );
    }

    if (claimsGeneratedArtifact(reply) || hasGeneratedFile(input) || input.imageUrl) {
      addIssue(
        issues,
        "wrong_artifact_path",
        "error",
        "Ora treated reference text as an artifact generation task.",
      );
    }
  }

  if (scenario === "pasted_report" || scenario === "pasted_error_log") {
    const userMentionsTools = mentionsAny(input.userMessage, [
      "Replit",
      "Codex",
      "ChatGPT",
      "GitHub",
    ]);
    if (userMentionsTools && !mentionsAny(reply, ["Replit", "Codex", "ChatGPT", "GitHub"])) {
      addIssue(
        issues,
        "missing_tool_actor",
        "error",
        "Ora did not identify the relevant tool/workspace actor from the pasted text.",
      );
    }
  }

  if (scenario === "direct_tool_reply") {
    if (!mentionsAny(reply, ["context", "paste", "details", "Replit", "Codex", "GitHub"])) {
      addIssue(
        issues,
        "missing_context_request",
        "warning",
        "Ora should either give the exact reply or ask for the missing tool context.",
      );
    }
  }

  if (scenario === "file_generation") {
    if (!hasGeneratedFile(input)) {
      addIssue(
        issues,
        "missing_file_payload",
        "error",
        "Ora claimed or attempted file generation without returning fileName, fileData, and mimeType.",
      );
    }
  }

  if (scenario === "image_generation") {
    if (input.signedIn && !input.imageUrl) {
      addIssue(
        issues,
        "missing_image_url",
        "error",
        "Signed-in image generation did not return an inline image URL.",
      );
    }

    if (!input.signedIn && /\b(can'?t|cannot|unable to)\s+generate\s+images?\b/i.test(reply)) {
      addIssue(
        issues,
        "bad_image_capability_claim",
        "error",
        "Anonymous image CTA incorrectly says Ora cannot generate images.",
      );
    }
  }

  if (scenario === "memory_recall") {
    if (!input.memoriesUsed?.length) {
      addIssue(
        issues,
        "missing_memory_signal",
        "error",
        "Memory recall answer did not surface a memoriesUsed signal.",
      );
    }

    if (!mentionsAny(reply, ["prefer", "remember", "direct", "style", "minimum", "concise"])) {
      addIssue(
        issues,
        "weak_memory_answer",
        "warning",
        "Memory recall answer does not clearly reference the remembered preference.",
      );
    }
  }

  const score = scoreIssues(issues);
  return {
    score,
    passed: score >= 80 && !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}
