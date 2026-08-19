/**
 * Live container preview proxy (Task #740).
 *
 * For `builder_mode = 'agentic'` projects, requests under
 * `/api/projects/:id/preview/*` are reverse-proxied to the project's
 * Fly machine dev-server URL (HTTP + WebSocket upgrades for Vite HMR).
 *
 * - Cold start: if the container is hibernated / stopped, the proxy
 *   auto-wakes it (best-effort, via the same pipeline `POST /container/start`
 *   uses) and returns a small "Starting your app…" HTML page that
 *   self-refreshes until the dev server responds.
 * - Errors: if the container is in `error` or has no `containerUrl`, an
 *   error HTML page is rendered with a link to the workspace logs tab.
 *
 * Static-legacy projects (`builder_mode = 'static-legacy'`) continue to be
 * served from `project_files` rows by the original handler in
 * `routes/files.ts`.
 */

import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { and, eq } from "drizzle-orm";
import { createProxyMiddleware, type RequestHandler } from "http-proxy-middleware";
import { getAuth } from "@clerk/express";
import { db, projectsTable, projectFilesTable, orgMembersTable } from "@workspace/db";
import {
  hasContainerLayerCredentials,
  isContainerLayerConfigured,
  provisionContainer,
  tenantRuntimeProvider,
} from "./tenant-runtime";
import { getContainerSecretMap } from "./container-secrets";
import { mintCloudflarePreviewGrant } from "./cloudflare-preview-grant";
import { logger } from "./logger";
import { previewFilePathFromUrl, serveProjectFilesPreview } from "./project-files-preview";
import { resolveProjectRuntimeManifest } from "./runtime-manifest";

const runtimeGatewayHostname = tenantRuntimeProvider.getGatewayHostname();
const runtimeGatewayLabel = tenantRuntimeProvider.getGatewayLabel();

type PreviewProxyState =
  | "container-starting"
  | "container-error"
  | "proxy-unavailable"
  | "server-unreachable";

// Probe once for startup logging, but keep request-time checks retryable.
void tenantRuntimeProvider.isGatewayReachable();

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
  if (matched?.rest) launchUrl.pathname = `${launchUrl.pathname}${matched.rest}`;
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
    .where(eq(projectsTable.id, projectId));
  if (!project) return null;

  if (!hasContainerLayerCredentials() && project.containerId) {
    await db
      .update(projectsTable)
      .set({ containerId: null, containerUrl: null, containerStatus: "stopped" })
      .where(eq(projectsTable.id, projectId));
    logger.info(
      { projectId, staleContainerId: project.containerId },
      "Cleared stale preview container because the container layer is disabled",
    );
    return { ...project, containerId: null, containerUrl: null, containerStatus: "stopped" };
  }

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

const PROXY_UNAVAILABLE_HTML = (projectId: number): string => `<!doctype html>
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
    void (async () => {
      wakingProjects.add(projectId);
      try {
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
      } catch (err) {
        logger.warn({ err, projectId }, "wakeContainer (preview proxy) failed");
      } finally {
        wakingProjects.delete(projectId);
      }
    })();
  });
}

function sendHtml(
  res: Response,
  status: number,
  html: string,
  previewState?: PreviewProxyState,
): void {
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
    const expressReq = req as IncomingMessage & { originalUrl?: string };
    const url = expressReq.originalUrl ?? req.url ?? "";
    const projectId = projectIdFromUrl(url);
    if (projectId == null) return undefined;
    const project = await loadPreviewProject(projectId);
    return project?.containerUrl ?? undefined;
  },
  pathRewrite: (path, req) => {
    // `path` is `req.url` (router-stripped inside the /api mount).
    // Prefer originalUrl so the rewrite always sees the full preview path.
    const expressReq = req as IncomingMessage & { originalUrl?: string };
    const sourceUrl = expressReq.originalUrl ?? path;
    const m = matchPreviewPath(sourceUrl.split("?")[0] ?? "");
    if (!m) return path;
    const query = sourceUrl.includes("?") ? sourceUrl.slice(sourceUrl.indexOf("?")) : "";
    const rest = m.rest ? `/${m.rest}` : "/";
    return rest + query;
  },
  on: {
    error: (err, req, target) => {
      logger.warn({ err }, "Preview proxy upstream error");
      const expressReq = req as IncomingMessage & { originalUrl?: string };
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
          const isEnvError = (err as NodeJS.ErrnoException).code === "ENOTFOUND";
          if (isEnvError) {
            const expressResponse = maybeRes as Response;
            void loadPreviewProject(projectId)
              .then((p) =>
                serveProjectFilesPreview(
                  expressResponse,
                  projectId,
                  previewFilePathFromUrl(expressReq.originalUrl ?? req.url),
                  {
                    projectStatus: p?.status ?? "draft",
                    showStaticBanner: true,
                    previewState: "static-fallback",
                  },
                ),
              )
              .catch((fallbackErr: unknown) => {
                logger.warn({ err: fallbackErr, projectId }, "Preview DB fallback failed");
                try {
                  sendHtml(
                    expressResponse,
                    502,
                    PROXY_UNAVAILABLE_HTML(projectId),
                    "proxy-unavailable",
                  );
                } catch {
                  /* swallow */
                }
              });
            return;
          }
          sendHtml(
            maybeRes as Response,
            502,
            ERROR_HTML(
              projectId,
              "Couldn't reach the dev server inside the container. It may still be starting or have crashed — check the logs and retry.",
            ),
            "server-unreachable",
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

/**
 * Express handler that proxies a preview request to the project's container.
 * Caller must already have authorised access to the project.
 */
export async function handleLivePreviewHttp(
  req: Request,
  res: Response,
  next: NextFunction,
  project: PreviewProject,
): Promise<void> {
  const cloudflareLaunchUrl = await resolveCloudflareLivePreviewLaunchUrl(
    project,
    req.originalUrl ?? req.url,
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

  // Container layer not configured in this environment — serve files from DB.
  if (!(await isContainerLayerConfigured())) {
    await serveProjectFilesPreview(
      res,
      project.id,
      previewFilePathFromUrl(req.originalUrl ?? req.url),
      { projectStatus: project.status, showStaticBanner: true, previewState: "static-fallback" },
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
    await serveProjectFilesPreview(
      res,
      project.id,
      previewFilePathFromUrl(req.originalUrl ?? req.url),
      { projectStatus: project.status, showStaticBanner: true, previewState: "static-fallback" },
    );
    return;
  }

  // Container is running — proxy through to the dev server.
  await proxyMiddleware(req, res, next);
}

/**
 * Confirm a WS upgrade originated from the same origin as the workspace
 * iframe. Vite/browsers always set Origin on a WS handshake. We accept
 * same-host requests and any host listed in REPLIT_DOMAINS. Missing
 * Origin is rejected to prevent off-site WS hijacking of an authed user's
 * cookie-bearing connection.
 */
function isAllowedUpgradeOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const reqHost = req.headers.host;
  if (reqHost && originHost === reqHost) return true;
  const allowed = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return allowed.includes(originHost);
}

/**
 * Handle a WebSocket upgrade against the preview path.
 *
 * Pre-condition: caller has already matched `matchPreviewPath`. We re-load
 * the project to confirm it is agentic + running before upgrading.
 *
 * Authorisation: published projects are public. For unpublished projects
 * we rely on (a) the Origin check below and (b) the fact that the iframe
 * that bootstrapped this socket already passed the HTTP auth gate in
 * `routes/files.ts`. The Origin check prevents an off-site page from
 * opening a cookie-bearing WS to another user's preview.
 */
export async function handleLivePreviewUpgrade(
  projectId: number,
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
): Promise<void> {
  const project = await loadPreviewProject(projectId);
  if (
    !project ||
    project.builderMode !== "agentic" ||
    project.containerStatus !== "running" ||
    !project.containerUrl
  ) {
    socket.destroy();
    return;
  }

  if (project.status !== "published") {
    // Defense-in-depth: same-origin check first.
    if (!isAllowedUpgradeOrigin(req)) {
      socket.destroy();
      return;
    }

    // Authorisation: verify the Clerk session cookie on the upgrade request
    // and confirm the user can preview this project. Mirrors the HTTP
    // gate in `routes/files.ts` so a logged-in stranger cannot open a WS
    // to someone else's private preview by guessing the project id.
    // eslint-disable-next-line no-useless-assignment
    let userId: string | null = null;
    try {
      const auth = getAuth(req as unknown as Parameters<typeof getAuth>[0]);
      userId = auth?.userId ?? null;
    } catch {
      userId = null;
    }
    if (!userId) {
      socket.destroy();
      return;
    }
    const allowed = await userCanPreviewProject(project, userId);
    if (!allowed) {
      socket.destroy();
      return;
    }
  }

  // proxyMiddleware.upgrade re-runs `router` + `pathRewrite` for us using req.url.
  proxyMiddleware.upgrade(req, socket, head);
}
