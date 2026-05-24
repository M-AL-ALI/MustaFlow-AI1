/**
 * Inline AI actions for the code editor.
 *
 * POST /api/projects/:id/ai/inline-action
 *   body: { fileId, selectedText, action: "explain"|"fix"|"rewrite"|"add-tests"|"complete" }
 *   Returns: { result: string }
 */

import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, projectFilesTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const INLINE_SYSTEM_PROMPT = `You are an expert software engineer assistant embedded in a code editor.
You receive a code snippet (and optionally the full file context) and perform a specific action.
- Be concise and precise — return ONLY the result without explanation unless asked.
- Preserve the original language, style, indentation, and formatting.
- For "explain" actions: return a brief explanation in plain English (2-5 sentences).
- For "fix" actions: return the corrected code only.
- For "rewrite" actions: return the improved code only.
- For "add-tests" actions: return the test code only (detect the testing framework from context).
- For "complete" actions: return the completion code only (no delimiters).
- Never wrap code in markdown fences unless the original file content uses markdown.`;

function buildPrompt(
  action: string,
  selectedText: string,
  fileContext: string,
  filePath: string,
): string {
  const contextHint = fileContext
    ? `\n\nFull file context (${filePath}):\n${fileContext.slice(0, 3000)}`
    : "";

  switch (action) {
    case "explain":
      return `Explain what this code does in plain English (2-5 sentences, no jargon):\n\n${selectedText}${contextHint}`;
    case "fix":
      return `Fix any bugs, syntax errors, or issues in this code. Return corrected code only:\n\n${selectedText}${contextHint}`;
    case "rewrite":
      return `Rewrite this code to be cleaner, more readable, and follow best practices. Return the improved code only:\n\n${selectedText}${contextHint}`;
    case "add-tests":
      return `Write comprehensive unit tests for this code. Detect the testing framework from the file context. Return test code only:\n\n${selectedText}${contextHint}`;
    case "complete":
      return `Continue this code from where it ends. Write the natural next 5-20 lines. Return only the continuation (no overlap with existing code):\n\n${selectedText}${contextHint}`;
    default:
      return selectedText;
  }
}

router.post(
  "/projects/:id/ai/inline-action",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = (req.body ?? {}) as {
      fileId?: unknown;
      selectedText?: unknown;
      action?: unknown;
      includeFileContext?: unknown;
    };

    const action = typeof body.action === "string" ? body.action : "";
    const selectedText =
      typeof body.selectedText === "string" ? body.selectedText.slice(0, 8000) : "";
    const fileId = typeof body.fileId === "number" ? body.fileId : null;
    const includeContext = body.includeFileContext !== false;

    const validActions = ["explain", "fix", "rewrite", "add-tests", "complete"];
    if (!validActions.includes(action)) {
      res.status(400).json({ error: `action must be one of: ${validActions.join(", ")}` });
      return;
    }

    if (!selectedText.trim()) {
      res.status(400).json({ error: "selectedText is required" });
      return;
    }

    let fileContext = "";
    let filePath = "";

    if (fileId && includeContext) {
      try {
        const [file] = await db
          .select({ content: projectFilesTable.content, path: projectFilesTable.path })
          .from(projectFilesTable)
          .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)));
        if (file) {
          fileContext = file.content;
          filePath = file.path;
        }
      } catch (err) {
        logger.warn({ err, projectId, fileId }, "Failed to load file context for inline action");
      }
    }

    const prompt = buildPrompt(action, selectedText, fileContext, filePath);

    try {
      const { createChatCompletion } = await import("../lib/ai-providers");
      const response = await createChatCompletion({
        provider: "openai",
        model: "gpt-5-mini",
        messages: [
          { role: "system", content: INLINE_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_completion_tokens: 2048,
      });

      const result = response.choices[0]?.message?.content ?? "";
      res.json({ result, action, fileId });
    } catch (err) {
      logger.error({ err, projectId, action }, "Inline AI action failed");
      const message = err instanceof Error ? err.message : "AI action failed";
      res.status(500).json({ error: message });
    }
  },
);

export default router;
