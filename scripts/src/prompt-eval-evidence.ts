import { createHash } from "node:crypto";

const MAX_EVIDENCE_CHARS = 24_000;
const STRING_EDGE_CHARS = 5_000;
const MAX_ARRAY_ITEMS = 40;
const MAX_OBJECT_KEYS = 80;
const MAX_DEPTH = 10;

export interface PromptEvalCandidateEvidence {
  display: string;
  outputChars: number;
  outputSha256: string;
  evidenceChars: number;
  jsonValid: boolean | null;
}

export interface PromptEvalJudgeDecision {
  score: number;
  reasoning: string;
}

export type PromptEvalGenerationIssue = "empty" | "invalid_json";

export function classifyPromptEvalGeneration(
  output: string,
  jsonMode: boolean,
): PromptEvalGenerationIssue | null {
  const trimmed = output.trim();
  if (trimmed.length === 0) return "empty";
  if (!jsonMode) return null;
  try {
    JSON.parse(trimmed);
    return null;
  } catch {
    return "invalid_json";
  }
}

function boundedText(value: string, limit = MAX_EVIDENCE_CHARS): string {
  if (value.length <= limit) return value;
  const marker = `\n[EVALUATION EVIDENCE TRUNCATED: ${value.length - limit} CHARS OMITTED; THIS IS NOT END-OF-FILE]\n`;
  const remaining = Math.max(0, limit - marker.length);
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

function projectValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return "[EVALUATION DEPTH BOUND REACHED]";
  if (typeof value === "string") {
    if (value.length <= STRING_EDGE_CHARS * 2) return value;
    return {
      kind: "bounded_text",
      chars: value.length,
      truncated: true,
      head: value.slice(0, STRING_EDGE_CHARS),
      tail: value.slice(-STRING_EDGE_CHARS),
    };
  }
  if (Array.isArray(value)) {
    const projected = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => projectValue(entry, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      projected.push({ omittedItems: value.length - MAX_ARRAY_ITEMS });
    }
    return projected;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const projected = Object.fromEntries(
      entries
        .slice(0, MAX_OBJECT_KEYS)
        .map(([key, entry]) => [key, projectValue(entry, depth + 1)]),
    ) as Record<string, unknown>;
    if (entries.length > MAX_OBJECT_KEYS) {
      projected.__omittedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    return projected;
  }
  return value;
}

export function buildPromptEvalCandidateEvidence(
  output: string,
  jsonMode: boolean,
): PromptEvalCandidateEvidence {
  const outputSha256 = createHash("sha256").update(output).digest("hex");
  let jsonValid: boolean | null = null;
  let body: string;

  if (jsonMode) {
    try {
      const parsed = JSON.parse(output) as unknown;
      jsonValid = true;
      body = [
        "AUTHORITATIVE STRUCTURAL PRECHECK: candidate JSON parsed successfully.",
        "The projection below is bounded evidence. Never treat a truncation marker as invalid JSON or end-of-file.",
        output.length <= MAX_EVIDENCE_CHARS
          ? output
          : JSON.stringify(projectValue(parsed), null, 2),
      ].join("\n\n");
    } catch {
      jsonValid = false;
      body = [
        "AUTHORITATIVE STRUCTURAL PRECHECK: candidate JSON did not parse.",
        "Bounded raw candidate:",
        output,
      ].join("\n\n");
    }
  } else {
    body = [
      "Candidate is plain text. A truncation marker is an evidence boundary, not end-of-file.",
      output,
    ].join("\n\n");
  }

  const display = boundedText(body);
  return {
    display,
    outputChars: output.length,
    outputSha256,
    evidenceChars: display.length,
    jsonValid,
  };
}

export function parsePromptEvalJudgeDecision(raw: string): PromptEvalJudgeDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.score !== "number" ||
    !Number.isInteger(candidate.score) ||
    candidate.score < 0 ||
    candidate.score > 10 ||
    typeof candidate.reasoning !== "string" ||
    candidate.reasoning.trim().length === 0
  ) {
    return null;
  }
  return { score: candidate.score, reasoning: candidate.reasoning.trim().slice(0, 200) };
}
