/**
 * Visual Edit endpoint (Task #539)
 *
 * Fast-path for click-to-edit changes from the preview iframe.
 *
 *   POST /projects/:id/visual-edit
 *     For static-html projects with a unique text match:
 *       • text → file.replace(oldText, escape(newText))
 *       • color (text/background) → find the enclosing tag of the matched
 *         text and set/replace the relevant inline style property.
 *       • padding → same, setting `padding`.
 *       • delete → strip the enclosing element (best-effort, only when the
 *         opening + matching closing tag can be balanced safely).
 *     Anything ambiguous or non-static returns `{ patched:false,
 *     suggestedPrompt }` so the frontend can hand off to the refine flow.
 *
 *   POST /projects/:id/visual-edit/resolve
 *     Locates the file (and line) that contains the selected element's
 *     text — powers the "View in Code" deep-link from the visual toolbar.
 *     Returns `{ fileId, filePath, line }` or 404 when nothing matches.
 */
import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  projectActivityTable,
  projectFilesTable,
  projectsTable,
  projectVersionsTable,
  visualEditChangesTable,
  visualEditSessionsTable,
  type VisualEditIntent,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { intentReceiptStore } from "../lib/zero-intent-receipt-store";

const router: IRouter = Router();

type EditBody = (
  | { sessionId: string; kind: "text"; mfmId: string; oldText: string; newText: string }
  | {
      sessionId: string;
      kind: "color";
      mfmId: string;
      target: "color" | "background";
      oldColor?: string;
      newColor: string;
      text?: string;
    }
  | {
      sessionId: string;
      kind: "style";
      mfmId: string;
      property:
        | "width"
        | "height"
        | "margin"
        | "text-align"
        | "display"
        | "object-fit"
        | "font-family"
        | "font-weight";
      value: string;
      text?: string;
    }
  | {
      sessionId: string;
      kind: "attribute";
      mfmId: string;
      attribute: "href" | "src";
      value: string;
      text?: string;
      oldValue?: string;
    }
  | {
      sessionId: string;
      kind: "padding";
      mfmId: string;
      oldPadding?: string;
      newPadding: string;
      text?: string;
    }
  | { sessionId: string; kind: "reorder"; mfmId: string; direction: "up" | "down"; text?: string }
  | { sessionId: string; kind: "delete"; mfmId: string; text?: string }
) & { breakpoint?: "desktop" | "tablet" | "mobile" };

router.post(
  "/projects/:id/visual-edit/sessions",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const actorUserId = req.userId;
    if (!Number.isInteger(projectId) || !actorUserId) {
      res.status(400).json({ error: "This visual editing session could not be started." });
      return;
    }
    const [existing] = await db
      .select()
      .from(visualEditSessionsTable)
      .where(
        and(
          eq(visualEditSessionsTable.projectId, projectId),
          eq(visualEditSessionsTable.actorUserId, actorUserId),
          eq(visualEditSessionsTable.status, "open"),
        ),
      )
      .orderBy(desc(visualEditSessionsTable.openedAt))
      .limit(1);
    if (existing) {
      res.json({ ok: true, sessionId: existing.id, resumed: true });
      return;
    }
    const sessionId = randomUUID();
    await db.insert(visualEditSessionsTable).values({
      id: sessionId,
      projectId,
      actorUserId,
      status: "open",
    });
    res.status(201).json({ ok: true, sessionId, resumed: false });
  },
);

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
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.mfmId !== "string" ||
      typeof body.sessionId !== "string" ||
      !req.userId
    ) {
      res.status(400).json({ error: "This visual change is missing its editing session." });
      return;
    }

    const [session] = await db
      .select()
      .from(visualEditSessionsTable)
      .where(eq(visualEditSessionsTable.id, body.sessionId));
    if (
      !session ||
      session.projectId !== projectId ||
      session.actorUserId !== req.userId ||
      session.status !== "open"
    ) {
      res.status(409).json({
        code: "visual_edit_session_unavailable",
        error: "This visual editing session is no longer open. Nothing was changed.",
      });
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
    const optionalText =
      "text" in body && typeof (body as { text?: string }).text === "string"
        ? ((body as { text?: string }).text as string).trim()
        : "";
    const anchorText =
      optionalText.length > 0
        ? optionalText
        : body.kind === "text"
          ? body.oldText
          : body.kind === "attribute"
            ? (body.oldValue ?? "")
            : "";

    if (isStaticHtml && (body.breakpoint ?? "desktop") === "desktop") {
      // Text edit: literal string replace, HTML-escaped.
      if (body.kind === "text") {
        const oldText = (body.oldText ?? "").trim();
        const newText = body.newText ?? "";
        if (oldText.length >= 2 && oldText.length <= 200 && newText.length <= 1000) {
          const file = await findUniqueHtmlFile(projectId, oldText);
          if (file) {
            const safeNewText = htmlEscape(newText);
            const updated = file.content.replace(oldText, escapeReplace(safeNewText));
            const changeId = await persistVisualChange({
              projectId,
              actorUserId: req.userId,
              sessionId: session.id,
              file,
              updated,
              intent: visualEditIntent(body),
            });
            const line = lineOfIndex(updated, updated.indexOf(safeNewText));
            res.json({
              ok: true,
              patched: true,
              filePath: file.path,
              fileId: file.id,
              line,
              kind: "text",
              changeId,
            });
            return;
          }
        }
      }

      // Color / padding edit: locate enclosing tag of the matched text and
      // splice the property into its inline `style` attribute.
      if (
        (body.kind === "color" || body.kind === "padding" || body.kind === "style") &&
        anchorText.trim().length >= 2 &&
        anchorText.trim().length <= 200
      ) {
        const trimmed = anchorText.trim();
        const file = await findUniqueHtmlFile(projectId, trimmed);
        if (file) {
          const property =
            body.kind === "color"
              ? body.target === "background"
                ? "background-color"
                : "color"
              : body.kind === "padding"
                ? "padding"
                : body.property;
          const value =
            body.kind === "color"
              ? body.newColor
              : body.kind === "padding"
                ? body.newPadding
                : body.value;
          if (typeof value === "string" && isSafeCssPropertyValue(property, value)) {
            const updated = patchInlineStyle(file.content, trimmed, property, value);
            if (updated && updated !== file.content) {
              const changeId = await persistVisualChange({
                projectId,
                actorUserId: req.userId,
                sessionId: session.id,
                file,
                updated,
                intent: visualEditIntent(body),
              });
              const line = lineOfIndex(updated, updated.indexOf(trimmed));
              res.json({
                ok: true,
                patched: true,
                filePath: file.path,
                fileId: file.id,
                line,
                kind: body.kind,
                changeId,
              });
              return;
            }
          }
        }
      }

      if (
        body.kind === "attribute" &&
        anchorText.trim().length >= 2 &&
        anchorText.trim().length <= 200 &&
        isSafeAttributeValue(body.attribute, body.value)
      ) {
        const trimmed = anchorText.trim();
        const file = await findUniqueHtmlFile(projectId, trimmed);
        if (file) {
          const updated = patchElementAttribute(file.content, trimmed, body.attribute, body.value);
          if (updated && updated !== file.content) {
            const changeId = await persistVisualChange({
              projectId,
              actorUserId: req.userId,
              sessionId: session.id,
              file,
              updated,
              intent: visualEditIntent(body),
            });
            res.json({
              ok: true,
              patched: true,
              filePath: file.path,
              fileId: file.id,
              line: lineOfIndex(updated, updated.indexOf(trimmed)),
              kind: body.kind,
              changeId,
            });
            return;
          }
        }
      }

      // Delete: strip the enclosing element by balancing tags around the anchor.
      if (body.kind === "delete" && anchorText.trim().length >= 2) {
        const trimmed = anchorText.trim();
        const file = await findUniqueHtmlFile(projectId, trimmed);
        if (file) {
          const updated = removeEnclosingElement(file.content, trimmed);
          if (updated && updated !== file.content) {
            const changeId = await persistVisualChange({
              projectId,
              actorUserId: req.userId,
              sessionId: session.id,
              file,
              updated,
              intent: visualEditIntent(body),
            });
            res.json({
              ok: true,
              patched: true,
              filePath: file.path,
              fileId: file.id,
              kind: "delete",
              changeId,
            });
            return;
          }
        }
      }
    }

    // Fallback: hand the change off to the agent via a pre-filled refine prompt.
    const suggestedPrompt = buildPrompt(body);
    res.json({
      ok: true,
      patched: false,
      kind: body.kind,
      refusal:
        "I couldn't safely tie that visual target to one source location, so nothing was changed.",
      suggestedPrompt,
    });
  },
);

router.post(
  "/projects/:id/visual-edit/sessions/:sessionId/undo",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const actorUserId = req.userId;
    const sessionId = String(req.params.sessionId ?? "");
    if (!Number.isInteger(projectId) || !actorUserId || !sessionId) {
      res.status(400).json({ error: "That visual change could not be undone." });
      return;
    }
    const [session] = await db
      .select()
      .from(visualEditSessionsTable)
      .where(eq(visualEditSessionsTable.id, sessionId));
    if (
      !session ||
      session.projectId !== projectId ||
      session.actorUserId !== actorUserId ||
      session.status !== "open"
    ) {
      res.status(409).json({ error: "This visual editing session is no longer open." });
      return;
    }
    const [change] = await db
      .select()
      .from(visualEditChangesTable)
      .where(
        and(
          eq(visualEditChangesTable.sessionId, sessionId),
          eq(visualEditChangesTable.status, "applied"),
        ),
      )
      .orderBy(desc(visualEditChangesTable.id))
      .limit(1);
    if (!change) {
      res.status(409).json({ error: "There is no visual change left to undo." });
      return;
    }
    const undone = await db.transaction(async (tx) => {
      const [file] = await tx
        .update(projectFilesTable)
        .set({ content: change.beforeContent, updatedAt: new Date() })
        .where(
          and(
            eq(projectFilesTable.id, change.fileId),
            eq(projectFilesTable.projectId, projectId),
            eq(projectFilesTable.content, change.afterContent),
          ),
        )
        .returning({ id: projectFilesTable.id });
      if (!file) return false;
      await tx
        .update(visualEditChangesTable)
        .set({ status: "undone", undoneAt: new Date() })
        .where(eq(visualEditChangesTable.id, change.id));
      return true;
    });
    if (!undone) {
      res.status(409).json({
        error: "The source changed after that edit, so undo stopped without overwriting it.",
      });
      return;
    }
    res.json({ ok: true, changeId: change.id, filePath: change.filePath });
  },
);

router.post(
  "/projects/:id/visual-edit/sessions/:sessionId/close",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const actorUserId = req.userId;
    const sessionId = String(req.params.sessionId ?? "");
    if (!Number.isInteger(projectId) || !actorUserId || !sessionId) {
      res.status(400).json({ error: "That visual editing session could not be saved." });
      return;
    }
    const [session] = await db
      .select()
      .from(visualEditSessionsTable)
      .where(eq(visualEditSessionsTable.id, sessionId));
    if (!session || session.projectId !== projectId || session.actorUserId !== actorUserId) {
      res.status(404).json({ error: "Visual editing session not found." });
      return;
    }
    if (session.status === "closed") {
      res.json({ ok: true, sessionId, versionId: session.versionId, alreadyClosed: true });
      return;
    }
    const changes = await db
      .select()
      .from(visualEditChangesTable)
      .where(
        and(
          eq(visualEditChangesTable.sessionId, sessionId),
          eq(visualEditChangesTable.status, "applied"),
        ),
      )
      .orderBy(visualEditChangesTable.id);
    const requestedSummary = typeof req.body?.summary === "string" ? req.body.summary.trim() : "";
    const uniqueFiles = new Set(changes.map((change) => change.filePath));
    const summary = (
      requestedSummary ||
      `Restyled ${uniqueFiles.size} ${uniqueFiles.size === 1 ? "file" : "files"} with ${changes.length} visual ${changes.length === 1 ? "change" : "changes"}`
    ).slice(0, 160);
    if (changes.length === 0) {
      await db
        .update(visualEditSessionsTable)
        .set({ status: "cancelled", summary: "No visual changes", closedAt: new Date() })
        .where(eq(visualEditSessionsTable.id, sessionId));
      res.json({ ok: true, sessionId, versionId: null, noChanges: true });
      return;
    }
    const files = await db
      .select({
        path: projectFilesTable.path,
        content: projectFilesTable.content,
        mimeType: projectFilesTable.mimeType,
      })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
    const versionId = await db.transaction(async (tx) => {
      const [version] = await tx
        .insert(projectVersionsTable)
        .values({
          projectId,
          label: `Visual edit: ${summary}`,
          note: `${changes.length} source-backed visual ${changes.length === 1 ? "change" : "changes"}`,
          changelogEntry: summary,
          filesSnapshot: files,
        })
        .returning({ id: projectVersionsTable.id });
      if (!version) throw new Error("visual edit version unavailable");
      await tx
        .update(visualEditSessionsTable)
        .set({ status: "closed", summary, versionId: version.id, closedAt: new Date() })
        .where(eq(visualEditSessionsTable.id, sessionId));
      await tx.insert(projectActivityTable).values({
        projectId,
        actorId: actorUserId,
        eventType: "visual_edit",
        summary,
        metadata: {
          sessionId,
          versionId: version.id,
          changeCount: changes.length,
          changes: changes.map((change) => ({
            id: change.id,
            filePath: change.filePath,
            intent: change.intent,
          })),
        },
      });
      return version.id;
    });
    res.json({ ok: true, sessionId, versionId, summary, changeCount: changes.length });
  },
);

/**
 * Resolve a clicked preview element back to a source file + line.
 * Powers the "View in Code" button in the visual-edit toolbar.
 */
router.post(
  "/projects/:id/visual-edit/resolve",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (text.length < 2) {
      res.status(400).json({ error: "Missing or too-short text" });
      return;
    }
    // Search HTML first, then fall back to any text file (JSX/JS) so we can
    // still deep-link react-vite projects when the snippet is unique.
    const allFiles = await db
      .select()
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
    const candidates = allFiles
      .filter((f) => !!f.content && typeof f.content === "string")
      .map((f) => ({ file: f, count: occurrences(f.content, text) }))
      .filter((c) => c.count === 1);
    if (candidates.length === 0) {
      res.status(404).json({ error: "No unique source location" });
      return;
    }
    // Prefer HTML files when multiple unique matches exist across formats.
    candidates.sort((a, b) => {
      const ah = a.file.mimeType === "text/html" ? 0 : 1;
      const bh = b.file.mimeType === "text/html" ? 0 : 1;
      return ah - bh;
    });
    const pick = candidates[0]!.file;
    const idx = pick.content.indexOf(text);
    const line = lineOfIndex(pick.content, idx);
    res.json({ ok: true, fileId: pick.id, filePath: pick.path, line });
  },
);

// ── helpers ───────────────────────────────────────────────────────────────

async function findUniqueHtmlFile(projectId: number, needle: string) {
  const htmlFiles = await db
    .select()
    .from(projectFilesTable)
    .where(
      and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.mimeType, "text/html")),
    );
  const hits = htmlFiles.filter((f) => occurrences(f.content, needle) === 1);
  return hits.length === 1 ? hits[0]! : null;
}

function visualEditIntent(body: EditBody): VisualEditIntent {
  const kind = body.kind === "padding" ? "style" : body.kind;
  return {
    schema: "visual-edit-intent-v1",
    kind,
    target: body.mfmId.slice(0, 512),
    reason: buildPrompt(body).slice(0, 500),
  };
}

async function persistVisualChange(input: {
  projectId: number;
  actorUserId: string;
  sessionId: string;
  file: typeof projectFilesTable.$inferSelect;
  updated: string;
  intent: VisualEditIntent;
}): Promise<number> {
  const receipt = await intentReceiptStore.persist(input.projectId, randomUUID(), {
    intent: "mutate",
    decidingSource: "user_explicit",
    confidence: null,
    reasonCode: "explicit_control",
  });
  return await db.transaction(async (tx) => {
    const [updatedFile] = await tx
      .update(projectFilesTable)
      .set({ content: input.updated, updatedAt: new Date() })
      .where(
        and(
          eq(projectFilesTable.id, input.file.id),
          eq(projectFilesTable.projectId, input.projectId),
          eq(projectFilesTable.content, input.file.content),
        ),
      )
      .returning({ id: projectFilesTable.id });
    if (!updatedFile) throw new Error("visual edit source changed before persistence");
    const [change] = await tx
      .insert(visualEditChangesTable)
      .values({
        sessionId: input.sessionId,
        projectId: input.projectId,
        actorUserId: input.actorUserId,
        fileId: input.file.id,
        filePath: input.file.path,
        intentReceiptId: receipt.receiptId,
        intent: input.intent,
        beforeContent: input.file.content,
        afterContent: input.updated,
        status: "applied",
      })
      .returning({ id: visualEditChangesTable.id });
    if (!change) throw new Error("visual edit provenance unavailable");
    return change.id;
  });
}

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

function lineOfIndex(s: string, index: number): number {
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index; i++) if (s.charCodeAt(i) === 10) line++;
  return line;
}

// String.replace treats `$` as a backreference; escape so user text is literal.
function escapeReplace(s: string): string {
  return s.replace(/\$/g, "$$$$");
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Whitelist a small set of safe CSS value shapes so user-controlled
 * `value` cannot inject extra declarations / smuggle a `</style>` / etc.
 *   colors:  #rgb, #rrggbb, rgb()/rgba(), simple named colours
 *   lengths: 1–4 numeric components with `px`/`rem`/`em`/`%`
 */
function isSafeCssValue(v: string): boolean {
  if (!v || v.length > 80) return false;
  if (/[;<>"'`{}]/.test(v)) return false;
  const color = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-zA-Z]{3,32})$/;
  const length = /^(\s*-?\d+(\.\d+)?(px|rem|em|%)?\s*){1,4}$/;
  return color.test(v.trim()) || length.test(v);
}

function isSafeCssPropertyValue(property: string, value: string): boolean {
  if (property === "color" || property === "background-color" || property === "padding") {
    return isSafeCssValue(value);
  }
  if (property === "width" || property === "height" || property === "margin") {
    return isSafeCssValue(value);
  }
  if (property === "text-align") return /^(?:left|center|right|justify)$/u.test(value);
  if (property === "display") return /^(?:none|block|inline|inline-block|flex|grid)$/u.test(value);
  if (property === "object-fit") return /^(?:contain|cover|fill|none|scale-down)$/u.test(value);
  if (property === "font-weight") return /^(?:normal|bold|[1-9]00)$/u.test(value);
  if (property === "font-family") {
    return value.length <= 100 && /^[A-Za-z0-9 ,"'-]+$/u.test(value);
  }
  return false;
}

function isSafeAttributeValue(attribute: "href" | "src", value: string): boolean {
  if (!value || value.length > 2_000 || /[\u0000-\u001F<>"'`]/u.test(value)) return false;
  if (attribute === "src" && value.startsWith("data:image/")) {
    return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(value);
  }
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    const url = new URL(value);
    return attribute === "href"
      ? ["https:", "http:", "mailto:", "tel:"].includes(url.protocol)
      : ["https:", "http:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function patchElementAttribute(
  source: string,
  anchorText: string,
  attribute: "href" | "src",
  value: string,
): string | null {
  const anchorIdx = source.indexOf(anchorText);
  if (anchorIdx < 0) return null;
  const openStart = source.lastIndexOf("<", anchorIdx);
  const openEnd = openStart >= 0 ? source.indexOf(">", openStart) : -1;
  if (openStart < 0 || openEnd < 0) return null;
  const tag = source.slice(openStart, openEnd + 1);
  const expectedTag = attribute === "href" ? /^<a\b/iu : /^<img\b/iu;
  if (!expectedTag.test(tag)) return null;
  const escaped = value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
  const existing = new RegExp(`\\s${attribute}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "iu");
  const nextTag = existing.test(tag)
    ? tag.replace(existing, ` ${attribute}="${escaped}"`)
    : tag.replace(/\s*\/?>$/u, (ending) => ` ${attribute}="${escaped}"${ending}`);
  return source.slice(0, openStart) + nextTag + source.slice(openEnd + 1);
}

/**
 * Find the element that immediately encloses `anchorText` and add/replace
 * `property: value` in its inline `style=""` attribute.
 *
 * Approach (deliberately conservative — returns the original string if
 * anything looks ambiguous so the caller can fall back to a refine prompt):
 *   1. Locate `anchorText` in the source.
 *   2. Scan backwards for the nearest `<tag ...>` opening (skipping comments
 *      and other tags' content via shallow balance counting).
 *   3. If the opening already has `style="..."`, update or append the
 *      property. Otherwise insert a fresh `style="property: value"`.
 */
function patchInlineStyle(
  source: string,
  anchorText: string,
  property: string,
  value: string,
): string | null {
  const anchorIdx = source.indexOf(anchorText);
  if (anchorIdx < 0) return null;
  // Walk back to find the nearest opening tag of an element that wraps the
  // anchor (i.e. one without a matching `</tag>` between it and the anchor).
  let depth = 0;
  let scan = anchorIdx;
  let openIdx = -1;
  while (scan > 0) {
    const lt = source.lastIndexOf("<", scan - 1);
    if (lt < 0) break;
    // Skip comments
    if (source.startsWith("<!--", lt)) {
      scan = lt;
      continue;
    }
    const gt = source.indexOf(">", lt);
    if (gt < 0 || gt > anchorIdx) {
      scan = lt;
      continue;
    }
    const isClose = source[lt + 1] === "/";
    const isSelfClose = source[gt - 1] === "/";
    if (isClose) {
      depth++;
    } else if (!isSelfClose) {
      if (depth === 0) {
        // eslint-disable-next-line no-useless-assignment
        openIdx = lt;
        // Found the enclosing open tag — boundary is [lt, gt]
        return spliceStyle(source, lt, gt, property, value);
      }
      depth--;
    }
    scan = lt;
  }
  if (openIdx < 0) return null;
  return null;
}

function spliceStyle(
  source: string,
  openStart: number,
  openEnd: number,
  property: string,
  value: string,
): string {
  const tag = source.slice(openStart, openEnd + 1);
  // Existing style attribute? `style="..."` or `style='...'`
  const styleAttr = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
  let newTag: string;
  if (styleAttr) {
    const quote = styleAttr[1]!.startsWith('"') ? '"' : "'";
    const inner = (styleAttr[2] ?? styleAttr[3] ?? "").trim();
    const cleaned = inner
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.length > 0 && d.slice(0, d.indexOf(":")).trim().toLowerCase() !== property);
    cleaned.push(`${property}: ${value}`);
    const next = cleaned.join("; ");
    newTag =
      tag.slice(0, styleAttr.index) +
      ` style=${quote}${next}${quote}` +
      tag.slice(styleAttr.index + styleAttr[0].length);
  } else {
    // Insert style as the first attribute after the tag name.
    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
    if (!m) return source;
    const insertAt = m[0].length;
    newTag = tag.slice(0, insertAt) + ` style="${property}: ${value}"` + tag.slice(insertAt);
  }
  return source.slice(0, openStart) + newTag + source.slice(openEnd + 1);
}

/**
 * Remove the element that immediately encloses `anchorText`. Conservative —
 * only succeeds when we can balance opening + closing tags around the anchor.
 */
function removeEnclosingElement(source: string, anchorText: string): string | null {
  const anchorIdx = source.indexOf(anchorText);
  if (anchorIdx < 0) return null;
  // Find the enclosing opening tag using the same walk-back as patchInlineStyle.
  let depth = 0;
  let scan = anchorIdx;
  let openStart = -1;
  let openEnd = -1;
  let tagName = "";
  while (scan > 0) {
    const lt = source.lastIndexOf("<", scan - 1);
    if (lt < 0) break;
    if (source.startsWith("<!--", lt)) {
      scan = lt;
      continue;
    }
    const gt = source.indexOf(">", lt);
    if (gt < 0 || gt > anchorIdx) {
      scan = lt;
      continue;
    }
    const isClose = source[lt + 1] === "/";
    const isSelfClose = source[gt - 1] === "/";
    if (isClose) {
      depth++;
    } else if (!isSelfClose) {
      if (depth === 0) {
        openStart = lt;
        openEnd = gt;
        const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(source.slice(lt));
        tagName = m ? m[1]!.toLowerCase() : "";
        break;
      }
      depth--;
    }
    scan = lt;
  }
  if (openStart < 0 || !tagName) return null;
  // Now scan forward from openEnd looking for the matching </tagName>.
  const closer = new RegExp(`</${tagName}\\s*>`, "gi");
  closer.lastIndex = openEnd + 1;
  let nesting = 1;
  const opener = new RegExp(`<${tagName}(\\s|>)`, "gi");
  opener.lastIndex = openEnd + 1;
  let closeMatch: RegExpExecArray | null = null;
  while (nesting > 0) {
    const cm = closer.exec(source);
    if (!cm) return null;
    // Count any nested openings before this close.
    opener.lastIndex = openEnd + 1;
    let nestedOpens = 0;
    let om: RegExpExecArray | null;
    while ((om = opener.exec(source)) !== null && om.index < cm.index) nestedOpens++;
    nesting = 1 + nestedOpens;
    // Subtract closes already consumed (everything up to and including cm)
    const consumedCloses = (source.slice(0, cm.index + cm[0].length).match(closer) || []).length;
    nesting -= consumedCloses;
    if (nesting <= 0) {
      closeMatch = cm;
      break;
    }
  }
  if (!closeMatch) return null;
  return source.slice(0, openStart) + source.slice(closeMatch.index + closeMatch[0].length);
}

function buildPrompt(body: EditBody): string {
  const breakpoint =
    body.breakpoint && body.breakpoint !== "desktop"
      ? `At the ${body.breakpoint} breakpoint only, `
      : "";
  switch (body.kind) {
    case "text":
      return `Visual edit: ${breakpoint}change the text "${truncate(body.oldText)}" to "${truncate(body.newText)}". Update the file that contains it; leave everything else unchanged.`;
    case "color": {
      const target = body.target === "background" ? "background color" : "text color";
      const ctx = body.text ? ` (on the element containing "${truncate(body.text)}")` : "";
      return `Visual edit: ${breakpoint}change the ${target}${ctx} to ${body.newColor}. Keep all other styling unchanged.`;
    }
    case "padding": {
      const ctx = body.text ? ` (on the element containing "${truncate(body.text)}")` : "";
      return `Visual edit: ${breakpoint}change the padding${ctx} to ${body.newPadding}. Keep all other styling unchanged.`;
    }
    case "style": {
      const ctx = body.text ? ` on the element containing "${truncate(body.text)}"` : "";
      return `Visual edit: ${breakpoint}change ${body.property}${ctx} to ${body.value}. Keep every other property unchanged.`;
    }
    case "attribute": {
      const label = body.attribute === "href" ? "link destination" : "image";
      return `Visual edit: ${breakpoint}replace the ${label} on the selected element. Keep the rest of the page unchanged.`;
    }
    case "reorder": {
      const ctx = body.text ? ` containing "${truncate(body.text)}"` : "";
      return `Visual edit: ${breakpoint}move the selected element${ctx} one place ${body.direction}. Keep its styling and content unchanged.`;
    }
    case "delete": {
      const ctx = body.text ? ` containing "${truncate(body.text)}"` : "";
      return `Visual edit: ${breakpoint}delete the element${ctx}. Remove any orphaned wrappers but leave the rest of the layout intact.`;
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
