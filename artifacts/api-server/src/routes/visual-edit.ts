/**
 * Visual Edit endpoint (Task #539)
 *
 * Fast-path for click-to-edit changes from the preview iframe:
 *
 *   • For static-html projects with a clean text/color match, patches the file
 *     directly and returns `{ ok:true, patched:true, filePath }` — no LLM call,
 *     instant feedback.
 *   • For everything else (React/Vite, complex changes, ambiguous matches),
 *     returns `{ ok:true, patched:false, suggestedPrompt }` so the frontend
 *     can drop a refine prompt into the chat composer.
 *
 * Body shape:
 *   { kind: "text", mfmId, oldText, newText }
 *   { kind: "color", mfmId, target: "color"|"background", oldColor, newColor, text? }
 *   { kind: "padding", mfmId, oldPadding, newPadding, text? }
 *   { kind: "delete", mfmId, text? }
 */
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, projectsTable, projectFilesTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();

type EditBody =
  | { kind: "text"; mfmId: string; oldText: string; newText: string }
  | {
      kind: "color";
      mfmId: string;
      target: "color" | "background";
      oldColor?: string;
      newColor: string;
      text?: string;
    }
  | { kind: "padding"; mfmId: string; oldPadding?: string; newPadding: string; text?: string }
  | { kind: "delete"; mfmId: string; text?: string };

router.post(
  "/projects/:id/visual-edit",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const body = req.body as EditBody;
    if (!body || typeof body !== "object" || typeof body.mfmId !== "string") {
      res.status(400).json({ error: "Missing mfmId" });
      return;
    }

    const [project] = await db
      .select({ id: projectsTable.id, kind: projectsTable.kind })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const isStaticHtml = project.kind === "web" || project.kind == null;

    // Only attempt direct-patch for static-html text edits where the source
    // string is short, unique, and clearly safe to swap with a literal replace.
    if (isStaticHtml && body.kind === "text") {
      const oldText = (body.oldText ?? "").trim();
      const newText = body.newText ?? "";
      if (oldText.length >= 2 && oldText.length <= 200 && newText.length <= 1000) {
        // Find the unique HTML file containing the exact text.
        const htmlFiles = await db
          .select()
          .from(projectFilesTable)
          .where(
            and(
              eq(projectFilesTable.projectId, projectId),
              eq(projectFilesTable.mimeType, "text/html"),
            ),
          );
        const hits = htmlFiles.filter((f) => occurrences(f.content, oldText) === 1);
        if (hits.length === 1) {
          const file = hits[0]!;
          // HTML-escape the replacement so user input cannot break out of a
          // text node into HTML/script context. The browser's textContent
          // shows the original (unescaped) characters when these entities
          // are rendered.
          const safeNewText = htmlEscape(newText);
          const updated = file.content.replace(oldText, escapeReplace(safeNewText));
          await db
            .update(projectFilesTable)
            .set({ content: updated, updatedAt: new Date() })
            .where(eq(projectFilesTable.id, file.id));
          res.json({
            ok: true,
            patched: true,
            filePath: file.path,
            fileId: file.id,
            kind: "text",
          });
          return;
        }
      }
    }

    // Fallback: hand the change off to the agent via a pre-filled refine prompt.
    const suggestedPrompt = buildPrompt(body);
    res.json({
      ok: true,
      patched: false,
      kind: body.kind,
      suggestedPrompt,
    });
  },
);

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

// String.replace treats `$` as a backreference; escape so user text is literal.
function escapeReplace(s: string): string {
  return s.replace(/\$/g, "$$$$");
}

// Minimal HTML entity escape — prevents XSS / structural breakage when the
// user-supplied replacement is dropped into raw HTML source.
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPrompt(body: EditBody): string {
  switch (body.kind) {
    case "text":
      return `Visual edit: change the text "${truncate(body.oldText)}" to "${truncate(body.newText)}". Update the file that contains it; leave everything else unchanged.`;
    case "color": {
      const target = body.target === "background" ? "background color" : "text color";
      const ctx = body.text ? ` (on the element containing "${truncate(body.text)}")` : "";
      return `Visual edit: change the ${target}${ctx} to ${body.newColor}. Keep all other styling unchanged.`;
    }
    case "padding": {
      const ctx = body.text ? ` (on the element containing "${truncate(body.text)}")` : "";
      return `Visual edit: change the padding${ctx} to ${body.newPadding}. Keep all other styling unchanged.`;
    }
    case "delete": {
      const ctx = body.text ? ` containing "${truncate(body.text)}"` : "";
      return `Visual edit: delete the element${ctx}. Remove any orphaned wrappers but leave the rest of the layout intact.`;
    }
    default:
      return "Visual edit requested from the preview.";
  }
}

function truncate(s: string, n = 80): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

export default router;
