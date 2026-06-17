/**
 * Document-analysis prompt construction for Ora (PDF / DOCX / TXT / PPTX).
 *
 * The first-turn document upload path (/public-ai/file-analysis) previously
 * used only the bare ORA_SYSTEM_PROMPT with no structured framing, so document
 * answers were shallow. This module adds:
 *  - a mode classifier (full structured analysis vs targeted question),
 *  - a structured-deliverable addendum (executive summary, key findings,
 *    important details, risks, recommended actions, next steps),
 *  - automatic domain-expert framing detected from the question plus a sample
 *    of the document content, reusing the same expertise domains as /chat.
 *
 * The extracted document text is NEVER placed in the system prompt — it stays in
 * the untrusted user-turn block. Here we only run regexes over a sample of it to
 * pick a domain label, which cannot leak instructions into the system prompt.
 *
 * Nothing is logged in this module.
 */

import {
  detectOraExpertiseDomain,
  oraDomainExpertiseGuidance,
  type OraExpertiseDomain,
} from "./expertise.js";
import type { OraPlanTier } from "./model-router.js";

export type DocumentAnalysisMode = "full" | "targeted";

export interface DocumentAnalysisFraming {
  mode: DocumentAnalysisMode;
  domain: OraExpertiseDomain;
  addendum: string;
}

// Broad "analyze the whole thing" intent — produce the full structured
// deliverable. Verb/keyword driven so a generic upload prompt lands here.
const FULL_ANALYSIS_RE =
  /\b(analy[sz]e|analysis|summar(?:y|ize|ise|ising|izing)|review|assess|evaluate|evaluation|audit|breakdown|break\s+it?\s+down|overview|deep[\s-]?dive|walk\s+me\s+through|go\s+through|key\s+(?:points|findings|takeaways)|main\s+(?:points|takeaways)|tl;?dr|report\s+on|executive\s+summary|what(?:'s| is)\s+(?:in|this|it\s+about))\b/i;

// Focused "answer this one thing" intent — do not force the full template.
const TARGETED_RE =
  /\b(what\s+does|what\s+is\s+the|when\b|who\b|where\b|how\s+much|how\s+many|which\b|does\s+(?:it|the|this)|is\s+there|are\s+there|find\b|search\b|look\s+for|extract\b|quote\b|list\s+the|the\s+(?:section|clause|page|paragraph|figure|amount|date|deadline|penalty|term))\b/i;

/**
 * Classify whether the user wants a full structured analysis of the document or
 * a direct answer to a focused question. A short or vague prompt accompanying an
 * upload defaults to a full analysis; an explicit focused question stays
 * targeted so we never bury a one-line answer under a six-part report template.
 */
export function classifyDocumentAnalysisMode(message: string): DocumentAnalysisMode {
  const trimmed = message.trim();
  const hasFull = FULL_ANALYSIS_RE.test(trimmed);
  const hasTargeted = TARGETED_RE.test(trimmed);

  if (hasTargeted && !hasFull) return "targeted";
  if (hasFull) return "full";
  // No clear signal: a brief upload prompt ("here", "this file", "?") is a
  // request to analyze; a longer specific sentence is treated as a question.
  if (trimmed.length <= 80) return "full";
  return "targeted";
}

const FULL_ANALYSIS_GUIDANCE = [
  "## Document analysis task",
  "The user uploaded a document and wants you to analyze it. Produce a structured, professional deliverable grounded entirely in the document:",
  "- Executive summary: 2-4 sentences capturing the document's purpose and the single most important takeaway.",
  "- Key findings: the most important points, quantified or quoted where the document supports it.",
  "- Important details: specifics that matter — figures, dates, parties, obligations, terms, or sections — drawn directly from the document.",
  "- Risks or issues: gaps, ambiguities, red flags, or concerns evident in the document.",
  "- Recommended actions: concrete, prioritized actions the user should take based on the content.",
  "- Next steps: the immediate next step(s) for the user.",
  "Ground every point in the actual document. Do not invent facts, figures, names, dates, or sections that are not present. If a section above does not apply to this document, omit it rather than padding. If the document was clearly truncated or only partially readable, say so.",
].join("\n");

const TARGETED_GUIDANCE = [
  "## Document question task",
  "The user uploaded a document and asked a specific question about it. Answer that question directly first, using the exact details from the document and quoting or citing the relevant part. Then add only the brief supporting context that helps.",
  "Do not force a full report structure onto a focused question. If the document does not contain the answer, say so plainly instead of guessing.",
].join("\n");

const MAX_DOMAIN_DETECT_CHARS = 6_000;

/**
 * Build the document-analysis system addendum: a mode-specific structured-output
 * instruction plus domain-expert framing detected from the question and a sample
 * of the document content.
 */
export function buildDocumentAnalysisFraming(input: {
  message: string;
  filename: string;
  extractedText: string;
}): DocumentAnalysisFraming {
  const mode = classifyDocumentAnalysisMode(input.message);

  const detectionInput = [
    input.message,
    input.filename,
    input.extractedText.slice(0, MAX_DOMAIN_DETECT_CHARS),
  ].join("\n");
  const domain = detectOraExpertiseDomain(detectionInput, "general");

  const sections = [mode === "full" ? FULL_ANALYSIS_GUIDANCE : TARGETED_GUIDANCE];
  if (domain !== "general") {
    sections.push(
      [
        "## Domain expertise",
        `Approach this document as a domain expert. ${oraDomainExpertiseGuidance(domain)}`,
      ].join("\n"),
    );
  }

  return { mode, domain, addendum: `\n\n${sections.join("\n\n")}` };
}

/**
 * Token budget for document analysis. Full structured analyses get more room
 * than focused questions; signed-in core/wave plans get a further boost. Kept
 * modest on anonymous sessions to control cost while still beating the old flat
 * 2000-token ceiling.
 */
export function documentAnalysisMaxTokens(
  mode: DocumentAnalysisMode,
  planTier: OraPlanTier,
): number {
  const base = mode === "full" ? 3500 : 2200;
  const planBoost = planTier === "wave" ? 1000 : planTier === "core" ? 500 : 0;
  return base + planBoost;
}
