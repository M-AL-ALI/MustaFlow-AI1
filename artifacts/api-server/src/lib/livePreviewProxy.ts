/**
 * Live container preview proxy (Task #740).
 *
 * For projects with a real runtime, requests under
 * `/api/projects/:id/preview/*` are routed to that runtime (HTTP +
 * WebSocket upgrades for the direct-container path, or a signed browser
 * handoff for private Cloudflare runtimes).
 *
 * - Private Cloudflare previews only hand off an already running runtime.
 *   Unavailable previews render a read-only response; the explicit guarded
 *   `POST /container/start` owns accepted sealed-release resume.
 * - Legacy providers retain their best-effort cold-start wake behavior.
 * - Unavailable and error documents retain the enforced preview sandbox.
 *
 * Static-legacy projects (`builder_mode = 'static-legacy'`) continue to be
 * served from `project_files` rows by the original handler in
 * `routes/files.ts`.
 */

import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { and, eq, isNull } from "drizzle-orm";
import { createProxyMiddleware, type RequestHandler } from "http-proxy-middleware";
import { db, projectsTable, projectFilesTable, orgMembersTable } from "@workspace/db";
import {
  isContainerLayerConfigured,
  provisionContainer,
  tenantRuntimeProvider,
} from "./tenant-runtime";
import { getContainerSecretMap } from "./container-secrets";
import { mintCloudflarePreviewGrant } from "./cloudflare-preview-grant";
import { logger } from "./logger";
import { previewFilePathFromUrl, serveProjectFilesPreview } from "./project-files-preview";
import { resolveProjectRuntimeManifest } from "./runtime-manifest";
import { withActiveProjectLifecycle } from "./project-lifecycle";
import {
  protectPreviewDocument,
  previewDocumentCsp,
  previewDocumentEmbedderPolicy,
} from "./preview-document-policy";
import {
  filterPreviewResponseCookies,
  stripPreviewUpstreamCredentials,
} from "./preview-credentials";

type PreviewProxyState =
  | "container-starting"
  | "container-error"
  | "proxy-unavailable"
  | "server-unreachable";

// Accepts both the full path (`/api/projects/:id/preview/...`, as seen by the
// top-level WebSocket upgrade handler) and the router-relative path
// (`/projects/:id/preview/...`, as seen inside the `/api` mounted router
// where `req.url` has the mount prefix stripped).
const PREVIEW_PATH_RE = /^(?:\/api)?\/projects\/(\d+)\/preview(?:\/(.*))?$/;

/** Match a request path against the preview route. Returns null on mismatch. */
export function matchPreviewPath(pathname: string): { projectId: number; rest: string } | null {
  const m = PREVIEW_PATH_RE.exec(pathname);
  if (!m) return null;
  const projectId = Number(m[1]);
  if (!Number.isFinite(projectId)) return null;
  return { projectId, rest: m[2] ?? "" };
}

/** Pull the projectId out of a preview URL (path or full URL). */
function projectIdFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const pathname = url.split("?")[0] ?? "";
  return matchPreviewPath(pathname)?.projectId ?? null;
}

/**
 * Resolve the browser-facing launch URL for a private Cloudflare preview runtime.
 * Cloudflare descriptors intentionally have no directly reachable container URL;
 * the browser instead redeems a short-lived signed grant at the runtime data plane.
 */
export async function resolveCloudflareLivePreviewLaunchUrl(
  project: Pick<PreviewProject, "id" | "containerId" | "containerStatus" | "runtimePort" | "stack">,
  requestUrl: string | undefined,
  environment: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  if (!project.containerId || project.containerStatus !== "running") return null;
  const manifest = resolveProjectRuntimeManifest({
    runtimePort: project.runtimePort,
    stack: project.stack,
    legacyProfile: "fixed-node",
  });
  const grant = await mintCloudflarePreviewGrant(
    {
      projectId: project.id,
      runtimeId: project.containerId,
      servicePort: manifest.servicePort,
    },
    environment,
  );
  if (grant === null) return null;

  const sourceUrl = new URL(requestUrl ?? "/", "https://platform.invalid");
  const matched = matchPreviewPath(sourceUrl.pathname);
  const launchUrl = new URL(grant.launchUrl);
  if (matched?.rest) {
    launchUrl.pathname = `${launchUrl.pathname}${matched.rest}`;
  } else if (!matched && sourceUrl.pathname !== "/") {
    launchUrl.pathname = `${launchUrl.pathname}${sourceUrl.pathname.replace(/^\//, "")}`;
  }
  for (const [key, value] of sourceUrl.searchParams) {
    launchUrl.searchParams.append(key, value);
  }
  return launchUrl.toString();
}

type PreviewProject = {
  id: number;
  ownerId: string;
  organizationId: number | null;
  status: string;
  builderMode: string;
  containerId: string | null;
  containerStatus: string;
  containerUrl: string | null;
  stack: string | null;
  runtimePort: number | null;
};

type PublicPreviewContext = {
  projectId: number;
  requestUrl: string;
};

type PreviewProxyRequest = IncomingMessage & {
  originalUrl?: string;
  mustaFlowPublicPreview?: PublicPreviewContext;
};

/**
 * Decide whether the editor preview must use the live runtime path.
 *
 * `builderMode` is a historical creation label, not runtime truth. Sealed
 * generation can attach a running Cloudflare runtime before older rows have
 * been reclassified, so a demonstrably running runtime wins. The established
 * agentic + container path remains intact for stopped/wake behavior.
 */
export function shouldRouteToLivePreview(
  project: Pick<PreviewProject, "builderMode" | "containerId" | "containerStatus">,
): boolean {
  if (!project.containerId) return false;
  return project.builderMode === "agentic" || project.containerStatus === "running";
}

/** Private live sockets belong to the isolated Cloudflare gateway, never the API origin. */
export function shouldProxyLivePreviewUpgrade(
  _project: Pick<
    PreviewProject,
    "builderMode" | "containerId" | "containerStatus" | "containerUrl"
  >,
): boolean {
  return false;
}

export async function loadPreviewProject(projectId: number): Promise<PreviewProject | null> {
  const [project] = await db
    .select({
      id: projectsTable.id,
      ownerId: projectsTable.ownerId,
      organizationId: projectsTable.organizationId,
      status: projectsTable.status,
      builderMode: projectsTable.builderMode,
      containerId: projectsTable.containerId,
      containerStatus: projectsTable.containerStatus,
      containerUrl: projectsTable.containerUrl,
      stack: projectsTable.stack,
      runtimePort: projectsTable.runtimePort,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  if (!project) return null;
  return project;
}

/** Confirm the requester is allowed to preview an unpublished project. */
export async function userCanPreviewProject(
  project: Pick<PreviewProject, "ownerId" | "organizationId">,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  if (project.ownerId === userId) return true;
  if (project.organizationId == null) return false;
  const [member] = await db
    .select({ role: orgMembersTable.role })
    .from(orgMembersTable)
    .where(
      and(
        eq(orgMembersTable.organizationId, project.organizationId),
        eq(orgMembersTable.userId, userId),
      ),
    );
  return !!member;
}

const COLD_START_HTML = (projectId: number): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Starting your app…</title>
<meta http-equiv="refresh" content="2">
<style>
  html,body{margin:0;height:100%;background:#0a0f1c;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:18px;text-align:center;padding:24px}
  .spinner{width:36px;height:36px;border:3px solid #1f2937;border-top-color:#60a5fa;border-radius:50%;animation:spin 0.9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-weight:600;font-size:18px;margin:0;color:#f3f4f6}
  p{margin:0;color:#9ca3af;font-size:14px;max-width:380px;line-height:1.5}
</style></head>
<body><div class="wrap">
  <div class="spinner"></div>
  <h1>Starting your app…</h1>
  <p>Waking the container for project #${projectId}. This usually takes a few seconds — the page will refresh automatically.</p>
</div></body></html>`;

const ERROR_HTML = (projectId: number, reason: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Preview unavailable</title>
<style>
  html,body{margin:0;height:100%;background:#0a0f1c;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px;text-align:center;padding:24px}
  h1{font-weight:600;font-size:18px;margin:0;color:#f3f4f6}
  p{margin:0;color:#9ca3af;font-size:14px;max-width:420px;line-height:1.5}
  a{color:#60a5fa;text-decoration:none}
  a:hover{text-decoration:underline}
</style></head>
<body><div class="wrap">
  <h1>Preview unavailable</h1>
  <p>${reason}</p>
  <p><a href="/projects/${projectId}?tab=logs" target="_top">View container logs →</a></p>
</div></body></html>`;

const PROXY_UNAVAILABLE_HTML = (projectId: number): string => {
  const runtimeGatewayHostname = tenantRuntimeProvider.getGatewayHostname();
  const runtimeGatewayLabel = tenantRuntimeProvider.getGatewayLabel();
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Container preview unavailable</title>
<style>
  html,body{margin:0;height:100%;background:#0a0f1c;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px;text-align:center;padding:24px}
  h1{font-weight:600;font-size:18px;margin:0;color:#f3f4f6}
  p{margin:0;color:#9ca3af;font-size:14px;max-width:460px;line-height:1.5}
  code{font-family:ui-monospace,monospace;font-size:12px;background:#1f2937;padding:1px 5px;border-radius:4px}
  a{color:#60a5fa;text-decoration:none}
  a:hover{text-decoration:underline}
</style></head>
<body><div class="wrap">
  <h1>Container preview unavailable</h1>
  <p>Container preview is not available in this environment. The ${runtimeGatewayLabel} (<code>${runtimeGatewayHostname}</code>) could not be reached from here.</p>
  <p>Your app files are still saved in NabuFlow. Start a test preview, retry, or inspect container logs.</p>
  <p><a href="/projects/${projectId}?tab=logs" target="_top">View container logs →</a></p>
</div></body></html>`;
};

/**
 * Per-project set of in-flight wake attempts. Prevents multiple concurrent
 * provisionContainer calls (one per 2-second browser refresh of the 503 page)
 * from racing each other and leaving containerStatus permanently at "starting".
 */
const wakingProjects = new Set<number>();

/** Kick off an async wake of the container. Best-effort, never throws. */
function wakeContainer(projectId: number, runtimePort: number | null): void {
  // If a wake is already in progress for this project, skip — the in-flight
  // call will update the DB when it finishes (or times out).
  if (wakingProjects.has(projectId)) return;

  setImmediate(() => {
    void withActiveProjectLifecycle(projectId, async (session) => {
      wakingProjects.add(projectId);
      try {
        if (!(await session.assertActive())) return;
        const [fileRows, envVars] = await Promise.all([
          db
            .select({
              path: projectFilesTable.path,
              content: projectFilesTable.content,
            })
            .from(projectFilesTable)
            .where(eq(projectFilesTable.projectId, projectId)),
          // Only inject development + testing secrets into the dev container.
          // Production and staging secrets must never reach a dev container.
          getContainerSecretMap(projectId),
        ]);

        await provisionContainer(projectId, fileRows, envVars, { servicePort: runtimePort });
        await session.assertActive();
      } catch (err) {
        logger.warn({ err, projectId }, "wakeContainer (preview proxy) failed");
      } finally {
        wakingProjects.delete(projectId);
      }
    }).catch((err: unknown) => {
      wakingProjects.delete(projectId);
      logger.warn({ err, projectId }, "wakeContainer lifecycle admission failed");
    });
  });
}

function sendHtml(
  res: Response,
  status: number,
  html: string,
  previewState?: PreviewProxyState,
): void {
  // Loading and failure documents are embedded too. Keep the same enforced
  // sandbox and COEP as successful private preview documents.
  protectPreviewDocument(res);
  if (previewState) {
    res.setHeader("X-MustaFlow-Preview-State", previewState);
  }
  res
    .status(status)
    .type("text/html")
    .setHeader("Cache-Control", "no-store, must-revalidate")
    .send(html);
}

/**
 * Singleton proxy middleware. The `router` callback resolves the target
 * dynamically per request by looking up the project's container URL.
 * Returning `undefined` from `router` falls back to `target`, which we
 * leave as an unreachable sentinel — guarded by the explicit pre-check
 * in `handleLivePreviewHttp` so the proxy is only invoked when a real
 * containerUrl exists.
 */
const proxyMiddleware: RequestHandler = createProxyMiddleware({
  target: "http://__preview_unconfigured__.invalid",
  changeOrigin: true,
  ws: true,
  xfwd: true,
  router: async (req) => {
    // Inside the mounted `/api` router Express strips the prefix from
    // `req.url`, so prefer `req.originalUrl` (always full path) and fall
    // back to `req.url` for the WS upgrade case where originalUrl is unset.
    const expressReq = req as PreviewProxyRequest;
    if (expressReq.mustaFlowPublicPreview) {
      const project = await loadPreviewProject(expressReq.mustaFlowPublicPreview.projectId);
      return project?.containerUrl ?? undefined;
    }
    const url = expressReq.originalUrl ?? req.url ?? "";
    const projectId = projectIdFromUrl(url);
    if (projectId == null) return undefined;
    const project = await loadPreviewProject(projectId);
    return project?.containerUrl ?? undefined;
  },
  pathRewrite: (path, req) => {
    // `path` is `req.url` (router-stripped inside the /api mount).
    // Prefer originalUrl so the rewrite always sees the full preview path.
    const expressReq = req as PreviewProxyRequest;
    if (expressReq.mustaFlowPublicPreview) {
      return expressReq.mustaFlowPublicPreview.requestUrl;
    }
    const sourceUrl = expressReq.originalUrl ?? path;
    const m = matchPreviewPath(sourceUrl.split("?")[0] ?? "");
    if (!m) return path;
    const query = sourceUrl.includes("?") ? sourceUrl.slice(sourceUrl.indexOf("?")) : "";
    const rest = m.rest ? `/${m.rest}` : "/";
    return rest + query;
  },
  on: {
    proxyReq: stripPreviewUpstreamCredentials,
    proxyReqWs: stripPreviewUpstreamCredentials,
    proxyRes: (response, req) => {
      const cookies = filterPreviewResponseCookies(response.headers["set-cookie"]);
      if (cookies) response.headers["set-cookie"] = cookies;
      else delete response.headers["set-cookie"];
      const previewRequest = req as PreviewProxyRequest;
      const pathname = (previewRequest.originalUrl ?? req.url ?? "").split("?")[0];
      if (!previewRequest.mustaFlowPublicPreview && matchPreviewPath(pathname)) {
        response.headers["content-security-policy"] = previewDocumentCsp(
          response.headers["content-security-policy"],
        );
        response.headers["cross-origin-embedder-policy"] = previewDocumentEmbedderPolicy(
          response.headers["cross-origin-embedder-policy"],
        );
        response.headers["referrer-policy"] = "no-referrer";
        response.headers["x-content-type-options"] = "nosniff";
      }
    },
    error: (err, req, target) => {
      logger.warn({ err }, "Preview proxy upstream error");
      const expressReq = req as PreviewProxyRequest;
      const projectId = projectIdFromUrl(expressReq.originalUrl ?? req.url) ?? 0;
      const maybeRes = target as Partial<Response> & {
        headersSent?: boolean;
        destroy?: () => void;
      };
      if (
        maybeRes &&
        typeof (maybeRes as Response).status === "function" &&
        !maybeRes.headersSent
      ) {
        try {
          sendHtml(
            maybeRes as Response,
            502,
            (err as NodeJS.ErrnoException).code === "ENOTFOUND"
              ? PROXY_UNAVAILABLE_HTML(projectId)
              : ERROR_HTML(
                  projectId,
                  "Couldn't reach the dev server inside the container. It may still be starting or have crashed — check the logs and retry.",
                ),
            (err as NodeJS.ErrnoException).code === "ENOTFOUND"
              ? "proxy-unavailable"
              : "server-unreachable",
          );
        } catch {
          /* swallow */
        }
      } else if (maybeRes && typeof maybeRes.destroy === "function") {
        try {
          maybeRes.destroy();
        } catch {
          /* swallow */
        }
      }
    },
  },
});

function usesCloudflarePreview(provider: { providerId: string }): boolean {
  return provider.providerId === "cloudflare";
}

/**
 * Express handler that proxies a preview request to the project's container.
 * Caller must already have authorised access to the project.
 */
export async function handleLivePreviewHttp(
  req: Request,
  res: Response,
  next: NextFunction,
  project: PreviewProject,
  options?: { publicRequestUrl?: string },
): Promise<void> {
  const sourceRequestUrl = options?.publicRequestUrl ?? req.originalUrl ?? req.url;
  const cloudflareLaunchUrl = await resolveCloudflareLivePreviewLaunchUrl(
    project,
    sourceRequestUrl,
  );
  if (cloudflareLaunchUrl !== null) {
    res
      .status(302)
      .setHeader("Cache-Control", "no-store")
      .setHeader("Referrer-Policy", "no-referrer")
      .setHeader("Location", cloudflareLaunchUrl)
      .end();
    return;
  }

  // Cloudflare has no legacy file-provision capability, and a null direct URL
  // is normal for its private runtimes. A GET must not wake, provision, or
  // substitute draft files for an accepted sealed release. The guarded start
  // POST alone distinguishes a resumable release from a required fresh build.
  if (usesCloudflarePreview(tenantRuntimeProvider)) {
    sendHtml(
      res,
      project.containerStatus === "running" || project.containerStatus === "error" ? 502 : 503,
      ERROR_HTML(
        project.id,
        "The preview is not available. Opening this page does not start or rebuild the app. Use Wake preview in the workspace to resume an accepted build. If a fresh build is required, review Retry Build in Project history.",
      ),
      project.containerStatus === "error" ? "container-error" : "proxy-unavailable",
    );
    return;
  }

  // Runtime-selected previews fail explicitly when the container layer is
  // unavailable. Only a genuinely static request may use the DB fallback.
  if (!(await isContainerLayerConfigured())) {
    if (shouldRouteToLivePreview(project)) {
      sendHtml(res, 502, PROXY_UNAVAILABLE_HTML(project.id), "proxy-unavailable");
      return;
    }
    await serveProjectFilesPreview(res, project.id, previewFilePathFromUrl(sourceRequestUrl), {
      visualEditEnabled: options?.publicRequestUrl === undefined,
      showStaticBanner: true,
      previewState: "static-fallback",
    });
    return;
  }

  // A running private runtime must have produced the signed Cloudflare handoff
  // above. Never fall back to executing tenant HTML on the platform origin or
  // revive a historical direct-container endpoint. Static DB previews retain
  // their separately enforced document sandbox.
  if (!options?.publicRequestUrl && project.containerStatus === "running") {
    sendHtml(
      res,
      502,
      ERROR_HTML(
        project.id,
        "The isolated Cloudflare preview is unavailable. Your files are saved. Start a test preview or inspect the runtime configuration, then retry.",
      ),
      "proxy-unavailable",
    );
    return;
  }

  // No container provisioned yet — wake (best-effort) and show cold-start page.
  if (!project.containerId || !project.containerUrl) {
    wakeContainer(project.id, project.runtimePort);
    sendHtml(res, 503, COLD_START_HTML(project.id), "container-starting");
    return;
  }

  if (project.containerStatus === "error") {
    sendHtml(
      res,
      502,
      ERROR_HTML(
        project.id,
        "The container is in an error state. Inspect the build / runtime logs and retry.",
      ),
      "container-error",
    );
    return;
  }

  // Hibernated / stopped / starting → wake (idempotent) and show cold-start.
  if (project.containerStatus !== "running") {
    if (project.containerStatus === "hibernated" || project.containerStatus === "stopped") {
      wakeContainer(project.id, project.runtimePort);
    }
    sendHtml(res, 503, COLD_START_HTML(project.id), "container-starting");
    return;
  }

  // Guard: if the Fly proxy hostname isn't reachable in this environment
  // (e.g. Replit dev environment where mustaflow-containers.fly.dev doesn't
  // resolve), return a clear 502 with an environment-specific explanation
  // instead of crashing with ENOTFOUND. Status 502 (not 503) is intentional —
  // 503 would trigger the COLD_START_HTML auto-refresh meta tag.
  const reachable = await tenantRuntimeProvider.isGatewayReachable();
  if (!reachable) {
    sendHtml(res, 502, PROXY_UNAVAILABLE_HTML(project.id), "proxy-unavailable");
    return;
  }

  // Container is running — proxy through to the dev server.
  if (options?.publicRequestUrl) {
    (req as Request & { mustaFlowPublicPreview?: PublicPreviewContext }).mustaFlowPublicPreview = {
      projectId: project.id,
      requestUrl: options.publicRequestUrl,
    };
  }
  await proxyMiddleware(req, res, next);
}

/**
 * Retired platform-origin private upgrade entry point. HTTP hands live
 * previews to Cloudflare, where the signed project/runtime grant authorizes
 * HMR and application sockets. A published project does not make its private
 * editor socket public. Do not accept opaque origins or forward session
 * cookies here to compensate for a sandboxed legacy direct preview.
 */
export async function handleLivePreviewUpgrade(
  _projectId: number,
  _req: IncomingMessage,
  socket: Socket,
  _head: Buffer,
): Promise<void> {
  socket.destroy();
}
