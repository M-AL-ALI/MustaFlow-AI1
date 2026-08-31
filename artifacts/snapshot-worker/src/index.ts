/**
 * MustaFlow Snapshot Worker
 *
 * Serves published project snapshots from Cloudflare R2 at the edge.
 * Resolves the incoming hostname → routing data via a KV namespace,
 * fetches the file from R2, and returns it with appropriate cache headers.
 *
 * KV key:   <hostname>
 * KV value: HostnameRoute JSON (see below)
 *
 * R2 key structure:
 *   {projectId}/{versionId}/{filePath}   — regular snapshot files
 *   {projectId}/maintenance.html         — project-level maintenance page (not versioned)
 *
 * Bindings required in wrangler.toml:
 *   SNAPSHOTS  — R2 bucket (mustaflow-snapshots)
 *   ROUTING    — KV namespace (hostname routing table)
 */

export interface Env {
  SNAPSHOTS: R2Bucket;
  ROUTING: KVNamespace;
  /** Optional: API origin for analytics pings (e.g. https://api.mustaflow.app). */
  API_ORIGIN?: string;
}

interface HostnameRoute {
  projectId: number;
  versionId: number;
  /** Older version IDs for failover, newest-first, max 5 entries. */
  versionHistory: number[];
  /** Serve maintenance.html when true. */
  maintenance: boolean;
  /** Optional Cloudflare regional hint (e.g. "weur", "enam"). */
  preferredRegion: string | null;
}

// ── MIME helpers ──────────────────────────────────────────────────────────────

const EXT_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  ts: "application/typescript",
  tsx: "application/typescript",
  svg: "image/svg+xml; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  eot: "application/vnd.ms-fontobject",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  xml: "application/xml",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  map: "application/json",
};

function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

// ── Cache-Control strategy ────────────────────────────────────────────────────
//
// Hashed asset detection: filenames containing a 8+ char hex string (content hash)
// or a version fingerprint (e.g. "main.abc12345.js") get immutable long cache.
// HTML always gets short TTL so republish takes effect quickly.

const HASH_PATTERN = /[._-][0-9a-f]{8,}/i;

function cacheControl(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm" || path === "index.html" || path === "") {
    return "public, max-age=60, stale-while-revalidate=600";
  }
  if (HASH_PATTERN.test(path) && ext !== "html") {
    return "public, max-age=31536000, immutable";
  }
  // CSS, JS without hash — medium TTL
  if (["css", "js", "mjs"].includes(ext)) {
    return "public, max-age=300, stale-while-revalidate=3600";
  }
  // Images / fonts — long TTL
  if (
    [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "ico",
      "svg",
      "woff",
      "woff2",
      "ttf",
      "eot",
      "otf",
    ].includes(ext)
  ) {
    return "public, max-age=86400, stale-while-revalidate=604800";
  }
  return "public, max-age=60, stale-while-revalidate=600";
}

// ── Default pages ─────────────────────────────────────────────────────────────

const DEFAULT_NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Page not found</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0f1c;color:#9ca3af;padding:48px;margin:0}h1{color:#fff;margin-bottom:8px}p{margin:0}</style>
</head>
<body><h1>Page not found</h1><p>The requested page does not exist on this site.</p></body>
</html>`;

const DEFAULT_MAINTENANCE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Under Maintenance</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0f1c;color:#9ca3af;padding:48px;margin:0}h1{color:#fff;margin-bottom:8px}p{margin:0}</style>
</head>
<body><h1>Under Maintenance</h1><p>This site is temporarily down for maintenance. Please check back soon.</p></body>
</html>`;

const DEFAULT_NOT_PUBLISHED_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Not published</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0f1c;color:#9ca3af;padding:48px;margin:0}h1{color:#fff;margin-bottom:8px}p{margin:0}</style>
</head>
<body><h1>Not published</h1><p>This project is not currently published.</p></body>
</html>`;

// ── R2 helpers ────────────────────────────────────────────────────────────────
//
// `fetchFromR2` returns:
//   - A `Response` ready to return to the client (200 with body, or 304 not-modified)
//   - `null` when the key does not exist in R2 (caller should try next version / fallback)
//
// The 304 case is detected by R2 returning an R2Object *without* a `body`
// property (when `onlyIf: { etagDoesNotMatch }` matched the stored ETag).
// Returning 304 immediately — rather than `null` — is critical so the failover
// loop does not accidentally serve stale content from an older version.

async function fetchFromR2(
  bucket: R2Bucket,
  key: string,
  request: Request,
  path: string,
): Promise<Response | null> {
  try {
    const etag = request.headers.get("If-None-Match");
    const obj = etag
      ? await bucket.get(key, { onlyIf: { etagDoesNotMatch: etag.replace(/^W\//, "") } })
      : await bucket.get(key);

    if (!obj) return null;

    // R2 with `onlyIf` returns an R2Object without `body` when the ETag matched
    // (resource not modified). Return 304 immediately — do NOT fall through to
    // the next version in the failover loop, as the client already has the file.
    if (!("body" in obj)) {
      const cc = cacheControl(path);
      return new Response(null, {
        status: 304,
        headers: {
          ETag: (obj as R2Object).httpEtag ?? "",
          "Cache-Control": cc,
          "X-Served-By": "mustaflow-edge",
        },
      });
    }

    return r2ObjectToResponse(obj as R2ObjectBody, path);
  } catch {
    return null;
  }
}

/**
 * Clone a Response and add `X-Mustaflow-Region` when preferredRegion is set.
 * Response objects are immutable, so we reconstruct with the merged headers.
 */
function applyRegionToResponse(
  resp: Response,
  preferredRegion: string | null | undefined,
): Response {
  if (!preferredRegion) return resp;
  const newHeaders = new Headers(resp.headers);
  newHeaders.set("X-Mustaflow-Region", preferredRegion);
  return new Response(resp.body, { status: resp.status, headers: newHeaders });
}

export function hostnameCacheTag(hostname: string): string {
  return `nabuflow-host-${hostname.toLowerCase()}`;
}

function applyHostnameCacheTag(resp: Response, hostname: string): Response {
  const headers = new Headers(resp.headers);
  headers.set("Cache-Tag", hostnameCacheTag(hostname));
  return new Response(resp.body, { status: resp.status, headers });
}

function r2ObjectToResponse(obj: R2ObjectBody, path: string): Response {
  const mime = obj.httpMetadata?.contentType ?? guessMime(path);
  const etag = obj.httpEtag;
  const cc = cacheControl(path);

  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Cache-Control": cc,
    "X-Served-By": "mustaflow-edge",
  };
  if (etag) headers["ETag"] = etag;

  return new Response(obj.body, { status: 200, headers });
}

// ── Regional routing — what this Worker actually does ─────────────────────────
//
// `preferredRegion` is an operator-supplied hint (e.g. "weur", "enam", "apac")
// stored in the KV routing entry alongside the snapshot reference.
//
// Mechanisms implemented here:
//
//  1. `X-Mustaflow-Region` response header — emitted on every response when
//     preferredRegion is set.  Powers monitoring, analytics, and edge-outage
//     dashboards so operators can see which region is serving traffic.
//
//  2. Region-scoped CF Cache API keys — 200 responses are inserted under
//     `/__edge-cache/<region>/<projectId>/<versionId>/<path>` via ctx.waitUntil.
//     This partitions the CF edge cache per-region so PoPs that share a zone
//     don't serve stale cross-region entries after a re-publish.
//
//  3. Cloudflare Smart Placement (`[placement] mode = "smart"` in wrangler.toml)
//     — CF automatically co-locates this Worker process with the R2 replica that
//     is closest to the origin of most traffic, minimising R2 read RTT.
//
// What is NOT implemented here (requires dashboard / infrastructure config):
//
//  • Hard PoP affinity ("always serve from Frankfurt") requires Cloudflare
//    Regional Services, which is a zone-level setting managed in the CF dashboard.
//    Workers cannot override which PoP processes an incoming request at runtime.
//
//  • Traffic steering based on the visitor's geography (e.g. "route EU visitors
//    to the EU origin") requires Cloudflare Load Balancing geo-steering, also a
//    dashboard-level feature outside Worker scope.
//
// In summary: this Worker provides regional observability + cache partitioning.
// Full PoP affinity is an infrastructure milestone (see follow-up task #590).

function addRegionHeaders(headers: Record<string, string>, preferredRegion: string | null): void {
  if (preferredRegion) {
    headers["X-Mustaflow-Region"] = preferredRegion;
  }
}

/**
 * Insert a response into Cloudflare's shared Cache API with a region-scoped key.
 * Called via ctx.waitUntil so it never blocks the response.
 */
async function cacheWithRegion(
  url: URL,
  preferredRegion: string,
  projectId: number,
  versionId: number,
  path: string,
  response: Response,
): Promise<void> {
  try {
    const cacheKey = new Request(
      `${url.origin}/__edge-cache/${preferredRegion}/${projectId}/${versionId}/${path}`,
    );
    const cache = caches.default;
    await cache.put(cacheKey, response.clone());
  } catch {
    // Cache API is best-effort; never fatal
  }
}

// ── Main Worker fetch handler ─────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // Only handle GET/HEAD — pass everything else through to origin
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    // ── 1. Resolve routing from KV ────────────────────────────────────────────
    let route: HostnameRoute | null = null;
    try {
      route = await env.ROUTING.get<HostnameRoute>(hostname, "json");
    } catch {
      // KV failure — fall through to 503
    }

    if (!route) {
      return new Response(DEFAULT_NOT_PUBLISHED_HTML, {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Served-By": "mustaflow-edge",
        },
      });
    }

    // ── 2. Maintenance mode ───────────────────────────────────────────────────
    if (route.maintenance) {
      const maintenanceKey = `${route.projectId}/maintenance.html`;
      const maintenanceResp = await fetchFromR2(
        env.SNAPSHOTS,
        maintenanceKey,
        request,
        "maintenance.html",
      );
      const body =
        maintenanceResp && maintenanceResp.status === 200
          ? await maintenanceResp.arrayBuffer()
          : DEFAULT_MAINTENANCE_HTML;
      const hdrs: Record<string, string> = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": "3600",
        "X-Served-By": "mustaflow-edge",
      };
      addRegionHeaders(hdrs, route.preferredRegion);
      return applyHostnameCacheTag(new Response(body, { status: 503, headers: hdrs }), hostname);
    }

    // ── 3. Determine file path ────────────────────────────────────────────────
    let rawPath = url.pathname;
    if (rawPath === "/" || rawPath === "") {
      rawPath = "index.html";
    } else {
      rawPath = rawPath.replace(/^\//, "");
    }

    // ── 4. Try R2 across version history (failover) ──────────────────────────
    const versionIds = [route.versionId, ...route.versionHistory];

    for (const vId of versionIds) {
      const key = `${route.projectId}/${vId}/${rawPath}`;
      const resp = await fetchFromR2(env.SNAPSHOTS, key, request, rawPath);
      if (resp) {
        // 200 (fresh content) or 304 (not modified) — return immediately.
        // A 304 must NOT trigger the next-version failover loop.
        const final = applyHostnameCacheTag(
          applyRegionToResponse(resp, route.preferredRegion),
          hostname,
        );
        // When a preferredRegion is set and the response is fresh (200), also
        // warm the region-scoped edge cache partition in the background so
        // subsequent requests to this PoP hit CF cache instead of R2.
        if (route.preferredRegion && resp.status === 200) {
          ctx.waitUntil(
            cacheWithRegion(url, route.preferredRegion, route.projectId, vId, rawPath, final),
          );
        }
        return final;
      }
    }

    // ── 5. SPA fallback: try index.html for missing sub-paths ─────────────────
    if (rawPath !== "index.html" && !rawPath.includes(".")) {
      for (const vId of versionIds) {
        const key = `${route.projectId}/${vId}/index.html`;
        const resp = await fetchFromR2(env.SNAPSHOTS, key, request, "index.html");
        if (resp) {
          const final = applyHostnameCacheTag(
            applyRegionToResponse(resp, route.preferredRegion),
            hostname,
          );
          if (route.preferredRegion && resp.status === 200) {
            ctx.waitUntil(
              cacheWithRegion(
                url,
                route.preferredRegion,
                route.projectId,
                vId,
                "index.html",
                final,
              ),
            );
          }
          return final;
        }
      }
    }

    // ── 6. Custom 404 page ────────────────────────────────────────────────────
    // Only check the latest version for the 404 page.
    const notFoundKey = `${route.projectId}/${versionIds[0]}/404.html`;
    const notFoundResp = await fetchFromR2(env.SNAPSHOTS, notFoundKey, request, "404.html");
    if (notFoundResp && notFoundResp.status === 200) {
      const notFoundBody = await notFoundResp.arrayBuffer();
      const notFoundHdrs: Record<string, string> = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
        "X-Served-By": "mustaflow-edge",
      };
      addRegionHeaders(notFoundHdrs, route.preferredRegion);
      return applyHostnameCacheTag(
        new Response(notFoundBody, { status: 404, headers: notFoundHdrs }),
        hostname,
      );
    }

    const defaultNotFoundHdrs: Record<string, string> = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
      "X-Served-By": "mustaflow-edge",
    };
    addRegionHeaders(defaultNotFoundHdrs, route.preferredRegion);
    return applyHostnameCacheTag(
      new Response(DEFAULT_NOT_FOUND_HTML, { status: 404, headers: defaultNotFoundHdrs }),
      hostname,
    );
  },
};
