import type { Response } from "express";
import { and, asc, eq, or, like } from "drizzle-orm";
import { db, projectFilesTable } from "@workspace/db";
import { guessMime } from "./builder";
import { isBinaryMime } from "./binary-mime";
import { injectBridge, MOCK_FLAG_SCRIPT } from "./consoleBridge";
import { VISUAL_EDIT_SCRIPT } from "./visualEditScript";

const STATIC_PREVIEW_BANNER = `<style id="mustaflow-static-preview-style">
#mustaflow-static-preview{position:fixed;z-index:2147483647;left:50%;bottom:12px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);padding:7px 10px 7px 12px;border:1px solid rgba(148,163,184,.35);border-radius:8px;background:rgba(15,23,42,.92);box-shadow:0 8px 24px rgba(15,23,42,.24);color:#e2e8f0;font:12px/1.35 system-ui,-apple-system,sans-serif;backdrop-filter:blur(8px)}
#mustaflow-static-preview button{appearance:none;border:0;background:transparent;color:#cbd5e1;cursor:pointer;font:16px/1 system-ui;padding:0 1px}
</style><div id="mustaflow-static-preview" role="status"><span>Static preview — live server starting soon</span><button type="button" aria-label="Dismiss static preview notice" onclick="this.parentElement.remove();document.getElementById('mustaflow-static-preview-style')?.remove()">×</button></div>`;

function injectStaticPreviewBanner(html: string): string {
  if (html.includes('id="mustaflow-static-preview"')) return html;
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose >= 0) {
    return html.slice(0, bodyClose) + STATIC_PREVIEW_BANNER + html.slice(bodyClose);
  }
  return html + STATIC_PREVIEW_BANNER;
}

export function previewFilePathFromUrl(url: string | undefined): string {
  const pathname = (url ?? "").split("?")[0] ?? "";
  const match = /\/projects\/\d+\/preview(?:\/(.*))?$/.exec(pathname);
  const raw = match?.[1] ? decodeURIComponent(match[1]) : "";
  return raw === "" ? "index.html" : raw;
}

export async function serveProjectFilesPreview(
  res: Response,
  projectId: number,
  filePath: string,
  options: {
    visualEditEnabled: boolean;
    showStaticBanner?: boolean;
    previewState?: string;
  },
): Promise<void> {
  const [row] = await db
    .select()
    .from(projectFilesTable)
    .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, filePath)));

  let selectedRow =
    row ??
    (
      await db
        .select()
        .from(projectFilesTable)
        .where(
          and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "index.html")),
        )
    )[0];

  // Containerless server stacks commonly keep their entry page under
  // templates/. Only agentic fallback mode uses this extra lookup so the
  // established static-legacy index.html behavior remains unchanged.
  if (!selectedRow && options.showStaticBanner) {
    [selectedRow] = await db
      .select()
      .from(projectFilesTable)
      .where(
        and(
          eq(projectFilesTable.projectId, projectId),
          or(eq(projectFilesTable.mimeType, "text/html"), like(projectFilesTable.path, "%.html")),
        ),
      )
      .orderBy(asc(projectFilesTable.path))
      .limit(1);
  }

  if (!selectedRow) {
    res
      .status(404)
      .type("text/html")
      .send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">No preview yet</h1><p>Generate your app from the chat to see it here.</p></body></html>`,
      );
    return;
  }

  const mime = selectedRow.mimeType || guessMime(selectedRow.path);
  const isHtml = mime === "text/html" || selectedRow.path.endsWith(".html");
  if (options.previewState) {
    res.setHeader("X-MustaFlow-Preview-State", options.previewState);
  }
  res.type(mime).setHeader("Cache-Control", "no-store, must-revalidate");

  if (isBinaryMime(mime)) {
    res.end(Buffer.from(selectedRow.content, "base64"));
    return;
  }
  if (!isHtml) {
    res.send(selectedRow.content);
    return;
  }

  const html = injectBridge(
    selectedRow.content,
    options.visualEditEnabled ? `${MOCK_FLAG_SCRIPT}${VISUAL_EDIT_SCRIPT}` : "",
  );
  res.send(options.showStaticBanner ? injectStaticPreviewBanner(html) : html);
}
