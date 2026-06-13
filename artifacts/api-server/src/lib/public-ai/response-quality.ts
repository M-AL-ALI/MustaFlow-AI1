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
  requiredEvidence?: string[];
  maxReplyLines?: number;
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

function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

function hasMarkdownTable(text: string): boolean {
  const lines = stripFencedCode(text)
    .split(/\r?\n/)
    .map((line) => line.trim());

  return lines.some((line, index) => {
    const next = lines[index + 1] ?? "";
    return (
      line.includes("|") &&
      next.includes("|") &&
      /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(next)
    );
  });
}

function hasPipeSeparatorClutter(text: string): boolean {
  const linesWithPipes = stripFencedCode(text)
    .split(/\r?\n/)
    .filter((line) => /\s\|\s/.test(line));
  return linesWithPipes.length >= 2;
}

function hasRawMarkdownHeading(text: string): boolean {
  return /^#{1,6}\s+\S/m.test(stripFencedCode(text));
}

function hasDecorativeDivider(text: string): boolean {
  return /^[\s>*_=|$-]{4,}$/m.test(stripFencedCode(text));
}

function hasExcessiveBoldMarkers(text: string): boolean {
  const matches = stripFencedCode(text).match(/\*\*/g) ?? [];
  return matches.length >= 8;
}

function hasUnneededMathMarkup(text: string): boolean {
  return /\$\s*[\w\\][^$\n]{1,80}\$/.test(stripFencedCode(text));
}

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

function addCleanFormattingIssues(reply: string, issues: OraResponseQualityIssue[]) {
  if (hasMarkdownTable(reply)) {
    addIssue(
      issues,
      "formatting_table_clutter",
      "error",
      "Ora used a markdown table in a normal chat reply instead of cleaner prose or bullets.",
    );
  } else if (hasPipeSeparatorClutter(reply)) {
    addIssue(
      issues,
      "formatting_pipe_clutter",
      "warning",
      "Ora used pipe separators that tend to show as visual clutter in chat.",
    );
  }

  if (hasRawMarkdownHeading(reply)) {
    addIssue(
      issues,
      "formatting_heading_clutter",
      "error",
      "Ora used raw markdown heading markers instead of plain labels.",
    );
  }

  if (hasDecorativeDivider(reply)) {
    addIssue(
      issues,
      "formatting_divider_clutter",
      "warning",
      "Ora used decorative divider characters that are not needed in normal chat.",
    );
  }

  if (hasExcessiveBoldMarkers(reply)) {
    addIssue(
      issues,
      "formatting_bold_clutter",
      "warning",
      "Ora overused bold markers instead of reserving emphasis for important labels.",
    );
  }

  if (hasUnneededMathMarkup(reply)) {
    addIssue(
      issues,
      "formatting_math_clutter",
      "warning",
      "Ora used dollar-sign math markup where plain language would be cleaner.",
    );
  }
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

  addCleanFormattingIssues(reply, issues);

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

    if (input.suggestions?.length) {
      addIssue(
        issues,
        "unwanted_suggestions",
        "error",
        "Pasted/direct tool replies should not add generic follow-up suggestion chips.",
      );
    }

    if (input.maxReplyLines) {
      const visibleLines = reply.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
      if (visibleLines > input.maxReplyLines) {
        addIssue(
          issues,
          "too_many_steps",
          "warning",
          "Ora used more lines/steps than this direct-answer turn should need.",
        );
      }
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

    const requiredEvidence = (input.requiredEvidence ?? [])
      .map((detail) => detail.trim())
      .filter(Boolean);
    const missingEvidence = requiredEvidence.filter(
      (detail) => !reply.toLowerCase().includes(detail.toLowerCase()),
    );
    if (missingEvidence.length > 0) {
      addIssue(
        issues,
        "missing_pasted_detail",
        "error",
        `Ora did not mention key pasted detail(s): ${missingEvidence.join(", ")}.`,
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
