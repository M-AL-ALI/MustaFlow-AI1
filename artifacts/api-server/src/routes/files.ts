import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, projectFilesTable, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { guessMime } from "../lib/builder";

const router: IRouter = Router();

router.get(
  "/projects/:id/files",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const rows = await db
      .select({
        id: projectFilesTable.id,
        path: projectFilesTable.path,
        mimeType: projectFilesTable.mimeType,
        size: projectFilesTable.content,
        updatedAt: projectFilesTable.updatedAt,
      })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId))
      .orderBy(asc(projectFilesTable.path));

    res.json(
      rows.map((r) => ({
        id: r.id,
        path: r.path,
        mimeType: r.mimeType,
        size: r.size.length,
        updatedAt: r.updatedAt,
      })),
    );
  },
);

router.get(
  "/projects/:id/files/:fileId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isFinite(fileId)) {
      res.status(400).json({ error: "Invalid file id" });
      return;
    }
    const [row] = await db
      .select()
      .from(projectFilesTable)
      .where(
        and(
          eq(projectFilesTable.projectId, projectId),
          eq(projectFilesTable.id, fileId),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.json({
      id: row.id,
      path: row.path,
      mimeType: row.mimeType,
      content: row.content,
      updatedAt: row.updatedAt,
    });
  },
);

router.patch(
  "/projects/:id/files/:fileId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isFinite(fileId)) {
      res.status(400).json({ error: "Invalid file id" });
      return;
    }
    const { content } = req.body as { content?: unknown };
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }
    const [existing] = await db
      .select()
      .from(projectFilesTable)
      .where(
        and(
          eq(projectFilesTable.projectId, projectId),
          eq(projectFilesTable.id, fileId),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const [updated] = await db
      .update(projectFilesTable)
      .set({ content, updatedAt: new Date() })
      .where(
        and(
          eq(projectFilesTable.projectId, projectId),
          eq(projectFilesTable.id, fileId),
        ),
      )
      .returning();
    res.json({
      id: updated.id,
      path: updated.path,
      mimeType: updated.mimeType,
      content: updated.content,
      updatedAt: updated.updatedAt,
    });
  },
);

// Console bridge script injected into every HTML preview response so that
// console.log/warn/error/info and uncaught errors are forwarded to the parent
// frame via postMessage, regardless of how the iframe is loaded.
const CONSOLE_BRIDGE_SCRIPT = `<script>(function(){
  var _o={log:console.log,warn:console.warn,error:console.error,info:console.info};
  function relay(lv,args){
    try{
      window.parent.postMessage({__mustaflow:true,level:lv,args:Array.prototype.slice.call(args).map(function(a){
        try{return typeof a==="object"?JSON.stringify(a):String(a);}catch(e){return String(a);}
      })},"*");
    }catch(_){}
  }
  console.log=function(){relay("log",arguments);_o.log.apply(console,arguments);};
  console.warn=function(){relay("warn",arguments);_o.warn.apply(console,arguments);};
  console.error=function(){relay("error",arguments);_o.error.apply(console,arguments);};
  console.info=function(){relay("info",arguments);_o.info.apply(console,arguments);};
  window.addEventListener("error",function(e){
    window.parent.postMessage({__mustaflow:true,level:"error",args:[(e.message||"Script error")+(e.filename?" ("+e.filename+":"+e.lineno+")":"")]},"*");
  });
  window.addEventListener("unhandledrejection",function(e){
    var m=e.reason&&e.reason.message?e.reason.message:String(e.reason);
    window.parent.postMessage({__mustaflow:true,level:"error",args:["Unhandled rejection: "+m]},"*");
  });
})();<\/script>`;

function injectBridge(html: string): string {
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1${CONSOLE_BRIDGE_SCRIPT}`);
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, `$1<head>${CONSOLE_BRIDGE_SCRIPT}</head>`);
  }
  return `<head>${CONSOLE_BRIDGE_SCRIPT}</head>${html}`;
}

// Serves generated project files as the preview.
// PUBLISHED projects are publicly accessible without authentication — anyone
// with the URL can open the generated app.
// UNPUBLISHED projects require the requesting user to be the project owner.
router.get(
  "/projects/:id/preview/{*splat}",
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }

    // Resolve the project so we can check its publish status and ownership
    const [project] = await db
      .select({
        id: projectsTable.id,
        status: projectsTable.status,
        ownerId: projectsTable.ownerId,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project) {
      res
        .status(404)
        .type("text/html")
        .send(
          `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Project not found</h1></body></html>`,
        );
      return;
    }

    // Only published projects are publicly accessible.
    // All other statuses require the caller to own the project.
    if (project.status !== "published") {
      if (!req.userId) {
        res.status(401).json({ error: "Unauthenticated" });
        return;
      }
      if (project.ownerId !== req.userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    }

    const splat = req.params.splat;
    const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
    const filePath = raw === "" ? "index.html" : raw;

    const [row] = await db
      .select()
      .from(projectFilesTable)
      .where(
        and(
          eq(projectFilesTable.projectId, projectId),
          eq(projectFilesTable.path, filePath),
        ),
      );

    if (!row) {
      // Fallback to index.html so single-page-app routes resolve correctly
      const [fallback] = await db
        .select()
        .from(projectFilesTable)
        .where(
          and(
            eq(projectFilesTable.projectId, projectId),
            eq(projectFilesTable.path, "index.html"),
          ),
        );
      if (!fallback) {
        res
          .status(404)
          .type("text/html")
          .send(
            `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">No preview yet</h1><p>Generate your app from the chat to see it here.</p></body></html>`,
          );
        return;
      }
      res
        .type("text/html")
        .setHeader("Cache-Control", "no-store, must-revalidate")
        .send(injectBridge(fallback.content));
      return;
    }

    const mime = row.mimeType || guessMime(row.path);
    const isHtml = mime === "text/html" || row.path.endsWith(".html");
    res
      .type(mime)
      .setHeader("Cache-Control", "no-store, must-revalidate")
      .send(isHtml ? injectBridge(row.content) : row.content);
  },
);

export default router;
