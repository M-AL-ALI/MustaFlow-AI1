// Shared helper: serve a published project snapshot for a given project ID + file path.
// Used by both the /api/p/:slug/ public route and the custom-domain middleware.

import type { Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable, projectVersionsTable } from "@workspace/db";
import { guessMime } from "./builder";
import { injectBridge } from "./consoleBridge";
import { isBinaryMime } from "./binary-mime";

type SnapshotFile = { path: string; content: string; mimeType?: string };

const NOT_PUBLISHED_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Not published</h1><p>This project is not currently published.</p></body></html>`;
const SNAPSHOT_MISSING_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Snapshot missing</h1><p>Deployment snapshot not found. Please republish.</p></body></html>`;
const NOT_FOUND_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Page not found</h1></body></html>`;

/** Build a tiny analytics ping script to inject into published HTML pages. */
function buildAnalyticsSnippet(slug: string): string {
  return `<script>(function(){
  var s=document.cookie.match(/mf_view_session=([^;]+)/);
  var sid=s?s[1]:'';
  try{fetch('/api/p/${slug}/analytics/ping',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({referrer:document.referrer,path:location.pathname,sid:sid})});}catch(_){}
})();</script>`;
}

/** Inject og:image and og:title meta tags into an HTML string's <head>. */
function injectOgMeta(html: string, opts: {
  title?: string | null;
  description?: string | null;
  ogImageUrl?: string | null;
  slug: string;
}): string {
  const tags: string[] = [];
  if (opts.ogImageUrl) {
    tags.push(`<meta property="og:image" content="${opts.ogImageUrl.replace(/"/g, "&quot;")}">`);
    tags.push(`<meta name="twitter:image" content="${opts.ogImageUrl.replace(/"/g, "&quot;")}">`);
    tags.push(`<meta name="twitter:card" content="summary_large_image">`);
  }
  if (opts.title) {
    tags.push(`<meta property="og:title" content="${opts.title.replace(/"/g, "&quot;")}">`);
  }
  if (opts.description) {
    tags.push(`<meta property="og:description" content="${opts.description.replace(/"/g, "&quot;")}">`);
  }
  if (tags.length === 0) return html;
  const inject = tags.join("");
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1${inject}`);
  }
  return html;
}

export async function serveSnapshot(
  res: Response,
  projectId: number,
  filePath: string,
): Promise<void> {
  const [project] = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      description: projectsTable.description,
      status: projectsTable.status,
      publishedSnapshotId: projectsTable.publishedSnapshotId,
      publicSlug: projectsTable.publicSlug,
      siteTitle: projectsTable.siteTitle,
      metaDescription: projectsTable.metaDescription,
      deletedAt: projectsTable.deletedAt,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project || project.status !== "published" || !project.publishedSnapshotId) {
    res.status(404).type("text/html").send(NOT_PUBLISHED_HTML);
    return;
  }

  const [version] = await db
    .select({
      filesSnapshot: projectVersionsTable.filesSnapshot,
      ogImageUrl: projectVersionsTable.ogImageUrl,
    })
    .from(projectVersionsTable)
    .where(
      and(
        eq(projectVersionsTable.id, project.publishedSnapshotId),
        eq(projectVersionsTable.projectId, projectId),
      ),
    );

  if (!version || !Array.isArray(version.filesSnapshot)) {
    res.status(404).type("text/html").send(SNAPSHOT_MISSING_HTML);
    return;
  }

  // Handle og-image.svg route specially
  const slug = project.publicSlug ?? String(projectId);
  if (filePath === "og-image.svg") {
    const { generateOgSvg } = await import("./ogImage");
    const svg = generateOgSvg({
      name: project.siteTitle || project.name,
      description: project.metaDescription || project.description,
    });
    res
      .type("image/svg+xml")
      .setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
      .send(svg);
    return;
  }

  const snapshot = version.filesSnapshot as SnapshotFile[];
  let file = snapshot.find((f) => f.path === filePath);
  if (!file) file = snapshot.find((f) => f.path === "index.html");

  if (!file) {
    res.status(404).type("text/html").send(NOT_FOUND_HTML);
    return;
  }

  const mime = file.mimeType || guessMime(file.path);
  res.type(mime).setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  if (isBinaryMime(mime)) {
    res.end(Buffer.from(file.content, "base64"));
  } else {
    const isHtml = mime === "text/html";
    if (isHtml) {
      let html = injectBridge(file.content);
      // Inject analytics snippet
      const analyticsSnippet = buildAnalyticsSnippet(slug);
      if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${analyticsSnippet}</body>`);
      } else {
        html += analyticsSnippet;
      }
      // Inject OG image meta
      const ogUrl = version.ogImageUrl ?? `/api/p/${slug}/og-image.svg`;
      html = injectOgMeta(html, {
        title: project.siteTitle || project.name,
        description: project.metaDescription || project.description,
        ogImageUrl: ogUrl,
        slug,
      });
      res.send(html);
    } else {
      res.send(file.content);
    }
  }
}
