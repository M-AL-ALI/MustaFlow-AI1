/**
 * AI-planned in-place edit operations for uploaded Office files.
 *
 * The regex engines in `office-layout-edit.ts` only understand a fixed set of
 * phrasings ("replace \"A\" with \"B\"", "rename the sheet to X", ...). Any
 * in-place edit request phrased differently used to fall through to FULL
 * regeneration, silently destroying the user's original layout. This module is
 * the fallback between those two extremes: a small, fast model reads the
 * request plus the document's extracted text and either
 *   - returns a list of exact find→replace text operations that can be applied
 *     to the original file's XML text nodes (layout preserved), or
 *   - votes "regenerate" when the request genuinely needs structural changes
 *     (new slides/sheets/sections, charts, conversions, full rewrites).
 *
 * Fails safe: any provider error, timeout, or malformed output returns null so
 * the caller keeps its existing behavior.
 */
import { logger } from "../logger";
import {
  getOraProviderRoutingSnapshot,
  normalizeOraPlanTier,
  runCandidateChain,
  selectOraFileModelRoute,
} from "./model-router";
import { MAX_TEXT_CHARS_PER_FILE } from "./file-store.js";

export interface AiOfficeEditOp {
  /** Exact contiguous text as it appears in the document. */
  find: string;
  /** Replacement text; empty string deletes the passage. */
  replace: string;
}

export interface AiOfficeEditPlan {
  mode: "edit" | "regenerate";
  operations: AiOfficeEditOp[];
}

const MAX_OPS = 40;
const MAX_FIND_CHARS = 600;
const MAX_REPLACE_CHARS = 2000;

const PLANNER_SYSTEM_PROMPT = `You are a document edit planner. The user uploaded an Office file (Word/PowerPoint/Excel) and is asking for a change. Your job is to decide whether the request can be satisfied by replacing existing text passages IN PLACE (keeping the file's layout, styling, images, and structure untouched), and if so, to produce the exact operations.

Respond with STRICT JSON only, matching:
{"mode":"edit","operations":[{"find":"<exact text from the document>","replace":"<new text>"}]}
or
{"mode":"regenerate","operations":[]}

Rules:
- "mode":"edit" whenever the requested change can be expressed as replacing text that already exists in the document text below. This INCLUDES rewriting the content of a specific slide, section, sheet, or paragraph: emit one operation per affected paragraph/bullet/cell, with "find" copied VERBATIM from the document text and "replace" holding the new content. Use "" as "replace" to delete a passage.
- Rewriting one slide/section is NOT "regenerate". Example: for "slide 8 should cover X instead of Y", replace each of slide 8's bullets/paragraphs with new text about X, one operation per bullet.
- Each "find" is a contiguous passage of at most ${MAX_FIND_CHARS} characters. For a very long paragraph, use a distinctive prefix (the first 10+ words) as "find" — the whole matched passage is replaced.
- A "replace" may contain "\\n" line breaks to turn one bullet/paragraph into several.
- Prefer the SHORTEST unique passage that pinpoints each change. At most ${MAX_OPS} operations.
- "mode":"regenerate" ONLY when in-place text replacement genuinely cannot express the request: rewriting or restructuring the ENTIRE document, converting to another format, building a brand-new document, or adding slides/sheets/charts/images/tables that do not exist yet.
- If the text the user wants to change does not appear in the document text, use "mode":"edit" with an empty operations array — do NOT invent a "find" that is not in the document.
- Output JSON only. No commentary, no markdown fences.`;

/**
 * Extract the first balanced top-level JSON object from model output.
 * Providers (Gemini especially) sometimes append commentary after the JSON or
 * wrap it in prose despite response_format — both showed up in production as
 * SyntaxError fallthroughs that silently regenerated the user's file.
 */
export function extractPlannerJson(content: string): string | null {
  const stripped = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = stripped.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse planner JSON, tolerating trailing commas (a common Gemini artifact). */
export function parsePlannerJson(content: string): unknown | null {
  const jsonText = extractPlannerJson(content);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    try {
      return JSON.parse(jsonText.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
}

function sanitizePlan(raw: unknown): AiOfficeEditPlan | null {
  if (typeof raw !== "object" || raw === null) return null;
  const mode = (raw as { mode?: unknown }).mode;
  if (mode !== "edit" && mode !== "regenerate") return null;
  const rawOps = (raw as { operations?: unknown }).operations;
  const list = Array.isArray(rawOps) ? rawOps : [];
  const operations: AiOfficeEditOp[] = [];
  for (const op of list.slice(0, MAX_OPS)) {
    if (typeof op !== "object" || op === null) continue;
    const find = (op as { find?: unknown }).find;
    const replace = (op as { replace?: unknown }).replace;
    if (typeof find !== "string" || typeof replace !== "string") continue;
    const trimmedFind = find.trim();
    if (trimmedFind.length < 2 || trimmedFind.length > MAX_FIND_CHARS) continue;
    if (replace.length > MAX_REPLACE_CHARS) continue;
    operations.push({ find: trimmedFind, replace });
  }
  return { mode, operations: mode === "regenerate" ? [] : operations };
}

/**
 * Ask a fast model to plan exact in-place text operations for `message`
 * against the file's extracted text. Returns null on any failure (provider
 * outage, timeout, malformed output) so callers keep their prior behavior.
 */
export async function planAiOfficeEditOps(input: {
  message: string;
  extractedText: string;
  filename: string;
  fileType: "docx" | "pptx" | "xlsx";
  subscriptionTier?: string | null;
}): Promise<AiOfficeEditPlan | null> {
  const documentText = input.extractedText.slice(0, MAX_TEXT_CHARS_PER_FILE).trim();
  if (!documentText) return null;

  const planTier = normalizeOraPlanTier(input.subscriptionTier);
  const { available, openCircuits } = getOraProviderRoutingSnapshot();
  const candidates = selectOraFileModelRoute({
    task: "analysis",
    subscriptionTier: planTier,
    hasDocumentContext: true,
    available,
    openCircuits,
  });
  const timeoutMs = Number(process.env.ORA_OFFICE_EDIT_PLAN_TIMEOUT_MS) || 20_000;

  try {
    const { createChatCompletion } = await import("../ai-providers");
    const userContent = [
      `File: ${input.filename} (${input.fileType.toUpperCase()})`,
      "",
      "User request:",
      input.message.slice(0, 2_000),
      "",
      "Document text (extracted):",
      documentText,
    ].join("\n");

    const result = await Promise.race([
      runCandidateChain(
        candidates,
        (candidate) =>
          createChatCompletion({
            provider: candidate.provider,
            model: candidate.model,
            messages: [
              { role: "system", content: PLANNER_SYSTEM_PROMPT },
              { role: "user", content: userContent },
            ],
            response_format: { type: "json_object" },
            max_completion_tokens: 2_000,
          }),
        (candidate, i, err) =>
          logger.warn(
            {
              component: "ora-office-ai-edit",
              provider: candidate.provider,
              model: candidate.model,
              attempt: i + 1,
              ofCandidates: candidates.length,
              err,
            },
            "Office edit planner candidate failed — trying next provider",
          ),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("ora-office-edit-plan-timeout")), timeoutMs),
      ),
    ]);

    const content = result.result.choices[0]?.message?.content?.trim() ?? "";
    if (!content) return null;
    const parsed = parsePlannerJson(content);
    if (parsed === null) {
      logger.warn(
        { component: "ora-office-ai-edit", fileType: input.fileType },
        "Office edit planner output contained no parseable JSON object",
      );
      return null;
    }
    const plan = sanitizePlan(parsed);
    if (!plan) {
      logger.warn(
        { component: "ora-office-ai-edit", fileType: input.fileType },
        "Office edit planner returned an invalid plan shape",
      );
      return null;
    }
    logger.info(
      {
        component: "ora-office-ai-edit",
        provider: result.candidate.provider,
        model: result.candidate.model,
        mode: plan.mode,
        opCount: plan.operations.length,
        fileType: input.fileType,
      },
      "Office edit plan produced",
    );
    return plan;
  } catch (err) {
    logger.warn(
      { component: "ora-office-ai-edit", err, fileType: input.fileType },
      "Office edit planning failed — falling back to previous behavior",
    );
    return null;
  }
}
