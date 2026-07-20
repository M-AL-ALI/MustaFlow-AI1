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

const MAX_OPS = 20;
const MAX_FIND_CHARS = 300;
const MAX_REPLACE_CHARS = 1000;

const PLANNER_SYSTEM_PROMPT = `You are a document edit planner. The user uploaded an Office file (Word/PowerPoint/Excel) and is asking for a change. Your job is to decide whether the request can be satisfied by replacing existing text passages IN PLACE (keeping the file's layout, styling, images, and structure untouched), and if so, to produce the exact operations.

Respond with STRICT JSON only, matching:
{"mode":"edit","operations":[{"find":"<exact text from the document>","replace":"<new text>"}]}
or
{"mode":"regenerate","operations":[]}

Rules:
- "mode":"edit" ONLY when every requested change is a textual substitution of content that already exists in the document text below. Each "find" MUST be copied verbatim from the document text (a short contiguous passage, at most ${MAX_FIND_CHARS} characters). Use "" as "replace" to delete a passage.
- Prefer the SHORTEST unique passage that pinpoints the change (a phrase or sentence, not a whole paragraph).
- At most ${MAX_OPS} operations.
- "mode":"regenerate" when the request needs anything structural: adding/removing slides, sheets, sections, rows, columns, charts, images, converting formats, reordering content, restyling, or rewriting most of the document.
- If the text the user wants to change does not appear in the document text, use "mode":"edit" with an empty operations array — do NOT invent a "find" that is not in the document.
- Output JSON only. No commentary, no markdown fences.`;

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
    const jsonText = content
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const plan = sanitizePlan(JSON.parse(jsonText));
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
