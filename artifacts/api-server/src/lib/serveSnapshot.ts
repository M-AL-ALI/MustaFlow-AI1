// Shared helper: serve a published project snapshot for a given project ID + file path.
// Used by both the /api/p/:slug/ public route and the custom-domain middleware.

import type { Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectVersionsTable,
  previewSnapshotsTable,
  domainServeEventsTable,
  projectDomainsTable,
  projectBandwidthTable,
} from "@workspace/db";
import { guessMime } from "./builder";
import { injectBridge } from "./consoleBridge";
import { isBinaryMime } from "./binary-mime";
import { recordProdLog, hashIp } from "./prodLogs";
import { logger } from "./logger";

// ── Bandwidth metering (Task #624) ────────────────────────────────────────────
// In-memory accumulator keyed by "projectId:YYYY-MM". Flushed to DB every 30 s.
// Using a best-effort upsert so a flush failure never impacts request serving.

const bwAccumulator = new Map<string, { bytes: number; requests: number }>();

function bwCurrentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function bwAccumulate(projectId: number, bytes: number): void {
  const key = `${projectId}:${bwCurrentMonth()}`;
  const prev = bwAccumulator.get(key) ?? { bytes: 0, requests: 0 };
  bwAccumulator.set(key, { bytes: prev.bytes + bytes, requests: prev.requests + 1 });
}

async function bwFlush(): Promise<void> {
  if (bwAccumulator.size === 0) return;
  const snapshot = new Map(bwAccumulator);
  bwAccumulator.clear();

  const entries = [...snapshot.entries()].map(([key, val]) => {
    const [projectIdStr, month] = key.split(":") as [string, string];
    return { projectId: Number(projectIdStr), month, bytes: val.bytes, requests: val.requests };
  });

  for (const entry of entries) {
    try {
      await db
        .insert(projectBandwidthTable)
        .values({
          projectId: entry.projectId,
          month: entry.month,
          bytesServed: entry.bytes,
          requestCount: entry.requests,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [projectBandwidthTable.projectId, projectBandwidthTable.month],
          set: {
            bytesServed: sql`${projectBandwidthTable.bytesServed} + ${entry.bytes}`,
            requestCount: sql`${projectBandwidthTable.requestCount} + ${entry.requests}`,
            updatedAt: sql`now()`,
          },
        });
    } catch (err) {
      logger.warn({ err, projectId: entry.projectId }, "bwFlush: upsert failed");
    }
  }
}

// Flush every 30 seconds. `unref()` so the timer doesn't keep Node alive.
setInterval(() => {
  void bwFlush();
}, 30_000).unref();

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

/** Browser error beacon (Task #511). Posts unhandled errors + rejections to /api/p/:slug/log. */
function buildErrorBeaconSnippet(slug: string): string {
  return `<script>(function(){
  var q=[],t=null,MAX=10;
  function flush(){if(q.length===0)return;var payload={errors:q.splice(0,MAX)};try{fetch('/api/p/${slug}/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive:true});}catch(_){}t=null;}
  function push(e){if(q.length>=20)return;q.push(e);if(!t)t=setTimeout(flush,1000);}
  window.addEventListener('error',function(ev){push({message:String((ev&&ev.message)||'error'),stack:ev&&ev.error&&ev.error.stack?String(ev.error.stack).slice(0,3000):'',errorClass:ev&&ev.error&&ev.error.name?String(ev.error.name):'Error',url:location.pathname+location.search});});
  window.addEventListener('unhandledrejection',function(ev){var r=ev&&ev.reason;push({message:String((r&&r.message)||r||'unhandledrejection'),stack:r&&r.stack?String(r.stack).slice(0,3000):'',errorClass:r&&r.name?String(r.name):'UnhandledRejection',url:location.pathname+location.search});});
  window.addEventListener('beforeunload',flush);
})();</script>`;
}

/** Inject og:image and og:title meta tags into an HTML string's <head>. */
function injectOgMeta(
  html: string,
  opts: {
    title?: string | null;
    description?: string | null;
    ogImageUrl?: string | null;
    slug: string;
  },
): string {
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
    tags.push(
      `<meta property="og:description" content="${opts.description.replace(/"/g, "&quot;")}">`,
    );
  }
  if (tags.length === 0) return html;
  const inject = tags.join("");
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1${inject}`);
  }
  return html;
}

const STAGING_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Not staged</h1><p>This project has no staging snapshot.</p></body></html>`;
const PREVIEW_EXPIRED_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Preview expired</h1><p>This preview link has expired. Rebuild the app to generate a fresh one.</p></body></html>`;

/** Serve a snapshot directly by its snapshotId (used for staging and preview slots). */
async function serveSnapshotById(
  res: Response,
  projectId: number,
  snapshotId: number,
  filePath: string,
  label: string,
): Promise<void> {
  const [version] = await db
    .select({ filesSnapshot: projectVersionsTable.filesSnapshot })
    .from(projectVersionsTable)
    .where(
      and(eq(projectVersionsTable.id, snapshotId), eq(projectVersionsTable.projectId, projectId)),
    );

  if (!version || !Array.isArray(version.filesSnapshot)) {
    res.status(404).type("text/html").send(SNAPSHOT_MISSING_HTML);
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
  res.type(mime).setHeader("Cache-Control", "no-store").setHeader("X-Mustaflow-Env", label);
  if (isBinaryMime(mime)) {
    res.end(Buffer.from(file.content, "base64"));
  } else {
    let body = file.content;
    if (mime === "text/html") {
      body = injectBridge(body);
    }
    res.send(body);
  }
}

/**
 * Best-effort: record that a project snapshot was served.
 *
 * Task #645: writes the actual response byte count alongside the hit so the
 * workspace bandwidth rollup (`workspace_usage_daily.bandwidth_bytes`) has
 * real data backing the quota bar. Called for both custom-domain and
 * platform (`/api/p/:slug/`) serves; hostname is null for the latter and
 * gets normalised to '' by `rollupUsage`.
 */
function recordDomainServeEvent(
  projectId: number,
  hostname: string | null,
  bytesServed: number,
): void {
  setImmediate(() => {
    void (async () => {
      try {
        let domainId: number | null = null;
        if (hostname) {
          const [dom] = await db
            .select({ id: projectDomainsTable.id })
            .from(projectDomainsTable)
            .where(
              and(
                eq(projectDomainsTable.projectId, projectId),
                eq(projectDomainsTable.hostname, hostname),
              ),
            );
          domainId = dom?.id ?? null;
        }
        await db.insert(domainServeEventsTable).values({
          projectId,
          domainId,
          hostname,
          bytesServed: Math.max(0, Math.floor(bytesServed)),
        });
      } catch {
        /* best-effort, never throws */
      }
    })();
  });
}

/**
 * Attach a one-shot 'finish' listener that records the served byte count
 * after the response completes. Uses res.getHeader('content-length') which
 * Express sets automatically on res.send()/res.end(<Buffer|string>).
 */
function trackServeBytes(res: Response, projectId: number, hostname: string | null): void {
  res.once("finish", () => {
    if (res.statusCode >= 400) return; // only count successful serves
    const raw = res.getHeader("content-length");
    const bytes = typeof raw === "number" ? raw : Number(raw ?? 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    recordDomainServeEvent(projectId, hostname, bytes);
  });
}

/**
 * Serve a project snapshot identified by projectId + environment.
 * Used by the custom-domain middleware where the projectId is known
 * but the public slug may not be readily available.
 */
export async function serveSnapshotByProjectEnv(
  res: Response,
  projectId: number,
  filePath: string,
  env: "staging" | "production",
  hostname?: string,
): Promise<void> {
  const [project] = await db
    .select({
      id: projectsTable.id,
      status: projectsTable.status,
      publishedSnapshotId: projectsTable.publishedSnapshotId,
      stagingPublishedSnapshotId: projectsTable.stagingPublishedSnapshotId,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.status(404).type("text/html").send(NOT_PUBLISHED_HTML);
    return;
  }

  if (env === "staging") {
    if (!project.stagingPublishedSnapshotId) {
      res.status(404).type("text/html").send(STAGING_HTML);
      return;
    }
    await serveSnapshotById(
      res,
      projectId,
      project.stagingPublishedSnapshotId,
      filePath,
      "staging",
    );
    return;
  }

  if (project.status !== "published" || !project.publishedSnapshotId) {
    res.status(404).type("text/html").send(NOT_PUBLISHED_HTML);
    return;
  }
  // Task #645: record a serve event with the actual response byte count once
  // the response finishes. Hostname carries the custom domain (if any) so the
  // rollup can attribute bandwidth per-hostname.
  trackServeBytes(res, projectId, hostname ?? null);
  await serveSnapshotById(res, projectId, project.publishedSnapshotId, filePath, "production");
}

/** Serve staging snapshot for a project identified by its publicSlug. */
export async function serveSnapshotForEnv(
  res: Response,
  publicSlug: string,
  filePath: string,
  env: "staging",
): Promise<void> {
  const [project] = await db
    .select({
      id: projectsTable.id,
      stagingPublishedSnapshotId: projectsTable.stagingPublishedSnapshotId,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.publicSlug, publicSlug), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.status(404).type("text/html").send(NOT_PUBLISHED_HTML);
    return;
  }

  if (!project.stagingPublishedSnapshotId) {
    res.status(404).type("text/html").send(STAGING_HTML);
    return;
  }

  await serveSnapshotById(res, project.id, project.stagingPublishedSnapshotId, filePath, "staging");
}

/** Serve a preview snapshot identified by its previewSlug. */
export async function servePreviewSnapshot(
  res: Response,
  previewSlug: string,
  filePath: string,
): Promise<void> {
  const [preview] = await db
    .select({
      projectId: previewSnapshotsTable.projectId,
      versionId: previewSnapshotsTable.versionId,
      expiresAt: previewSnapshotsTable.expiresAt,
    })
    .from(previewSnapshotsTable)
    .where(eq(previewSnapshotsTable.previewSlug, previewSlug));

  if (!preview) {
    res.status(404).type("text/html").send(NOT_FOUND_HTML);
    return;
  }

  if (preview.expiresAt && new Date(preview.expiresAt) < new Date()) {
    res.status(410).type("text/html").send(PREVIEW_EXPIRED_HTML);
    return;
  }

  await serveSnapshotById(res, preview.projectId, preview.versionId, filePath, "preview");
}

export async function serveSnapshot(
  res: Response,
  projectId: number,
  filePath: string,
  reqMeta?: {
    method?: string;
    ip?: string;
    requestId?: string;
    userAgent?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  const writeRequestLog = (status: number, snapshotId: number | null): void => {
    try {
      recordProdLog({
        projectId,
        snapshotId,
        kind: "request",
        method: (reqMeta?.method ?? "GET").slice(0, 10),
        path: ("/" + (filePath ?? "")).slice(0, 500),
        status,
        latencyMs: Date.now() - startedAt,
        requestId: reqMeta?.requestId?.slice(0, 64) ?? null,
        ipHash: hashIp(reqMeta?.ip ?? null),
        userAgent: reqMeta?.userAgent?.slice(0, 200) ?? null,
      });
    } catch {
      /* best-effort */
    }
  };
  res.once("finish", () => writeRequestLog(res.statusCode, null));

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
      prodContainerUrl: projectsTable.prodContainerUrl,
      prodContainerStatus: projectsTable.prodContainerStatus,
      deletedAt: projectsTable.deletedAt,
      errorPage404: projectsTable.errorPage404,
      errorPage500: projectsTable.errorPage500,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project || project.status !== "published") {
    res.status(404).type("text/html").send(NOT_PUBLISHED_HTML);
    return;
  }

  // Task #645: record a serve event with the actual response byte count once
  // the response finishes. Public `/api/p/:slug/` traffic has no custom hostname,
  // so we pass null — `rollupUsage` maps that to '' for the platform bucket.
  trackServeBytes(res, projectId, null);

  // If a production container is deployed and running, proxy the request to it.
  if (project.prodContainerUrl && project.prodContainerStatus === "running") {
    const targetBase = project.prodContainerUrl.replace(/\/$/, "");
    const requestPath = filePath ? `/${filePath}` : "/";
    const targetUrl = `${targetBase}${requestPath}`;
    try {
      const upstreamRes = await fetch(targetUrl, {
        headers: { "X-Forwarded-Host": "mustaflow.app" },
        // Do not follow redirects automatically — forward them to the client.
        redirect: "manual",
      });
      // Forward status and select headers.
      res.status(upstreamRes.status);
      const contentType = upstreamRes.headers.get("content-type");
      if (contentType) res.setHeader("Content-Type", contentType);
      const location = upstreamRes.headers.get("location");
      if (location) res.setHeader("Location", location);
      res.setHeader("Cache-Control", "no-store");
      const body = await upstreamRes.arrayBuffer();
      res.end(Buffer.from(body));
    } catch {
      // Upstream container unreachable — fall back to snapshot serving below.
      // This can happen when the container is waking up or temporarily unavailable.
    }
    return;
  }

  if (!project.publishedSnapshotId) {
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
    // Serve custom 404 page if configured, otherwise fall back to platform default.
    const custom404 = project.errorPage404 ?? null;
    res
      .status(404)
      .type("text/html")
      .send(custom404 ?? NOT_FOUND_HTML);
    return;
  }

  const mime = file.mimeType || guessMime(file.path);
  res.type(mime).setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  if (isBinaryMime(mime)) {
    const buf = Buffer.from(file.content, "base64");
    bwAccumulate(projectId, buf.length);
    res.end(buf);
  } else {
    const isHtml = mime === "text/html";
    if (isHtml) {
      let html = injectBridge(file.content);
      // Inject analytics + error beacon snippets
      const analyticsSnippet = buildAnalyticsSnippet(slug);
      const errorBeacon = buildErrorBeaconSnippet(slug);
      const injected = analyticsSnippet + errorBeacon;
      if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${injected}</body>`);
      } else {
        html += injected;
      }
      // Inject OG image meta
      const ogUrl = version.ogImageUrl ?? `/api/p/${slug}/og-image.svg`;
      html = injectOgMeta(html, {
        title: project.siteTitle || project.name,
        description: project.metaDescription || project.description,
        ogImageUrl: ogUrl,
        slug,
      });
      bwAccumulate(projectId, Buffer.byteLength(html, "utf8"));
      res.send(html);
    } else {
      bwAccumulate(projectId, Buffer.byteLength(file.content, "utf8"));
      res.send(file.content);
    }
  }
}
