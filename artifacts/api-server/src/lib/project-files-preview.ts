/**
 * DB-fallback project files preview.
 *
 * When the Fly.io container layer is not configured (FLY_API_TOKEN absent),
 * agentic projects cannot run a live dev server.  For react-vite / static
 * stacks the frontend WebContainer handles preview client-side.  For all other
 * stacks (Express, Flask, Next.js server mode, etc.) this module renders a
 * lightweight HTML page from the project's DB snapshot so the user can see
 * their files without a 503 spinner that never resolves.
 */

import type { Response } from "express";
import { eq } from "drizzle-orm";
import { db, projectFilesTable } from "@workspace/db";

/** Stacks that can be rendered entirely in the browser (WebContainer or static). */
const CLIENT_RENDERABLE_STACKS = new Set(["react-vite", "static", "static-legacy"]);

/**
 * Returns true when the given stack can be previewed client-side without a
 * running server process.  The frontend WebContainer path handles these; the
 * DB-fallback page is only shown for server stacks.
 */
export function isClientRenderableStack(stack: string | null | undefined): boolean {
  return CLIENT_RENDERABLE_STACKS.has(stack ?? "");
}

function buildFallbackPage(projectId: number, fileCount: number, stack: string | null): string {
  const stackLabel = stack ?? "server";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview — project ${projectId}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:#0f172a;color:#e2e8f0;
  font:14px/1.6 ui-sans-serif,system-ui,sans-serif;
  display:flex;align-items:center;justify-content:center;min-height:100vh;
}
.card{
  max-width:480px;width:100%;
  background:#1e293b;border:1px solid #334155;border-radius:12px;
  padding:32px;
}
h1{font-size:1rem;font-weight:600;color:#f1f5f9;margin-bottom:8px}
p{color:#94a3b8;font-size:0.875rem;margin-bottom:12px}
code{
  background:#0f172a;border-radius:4px;
  padding:2px 6px;
  font:0.8rem ui-monospace,monospace;color:#7dd3fc;
}
.badge{
  display:inline-block;
  background:#0f172a;border:1px solid #334155;border-radius:6px;
  padding:2px 8px;font:0.75rem ui-monospace,monospace;color:#64748b;
  margin-bottom:16px;
}
a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
.files{color:#64748b;font-size:0.8125rem}
</style>
</head>
<body>
<div class="card">
  <div class="badge">${stackLabel}</div>
  <h1>Live preview unavailable</h1>
  <p>
    This <strong>${stackLabel}</strong> project requires a running server process.
    Live container preview needs <code>FLY_API_TOKEN</code>,
    <code>FLY_APP_NAME</code>, and <code>FLY_ORG_SLUG</code> to be configured.
  </p>
  <p class="files">
    ${fileCount} file${fileCount !== 1 ? "s" : ""} saved in MustaFlow —
    use <a href="/projects/${projectId}?tab=test-preview" target="_top">Test Preview</a>
    to run your app, or add Fly credentials to enable live container preview.
  </p>
</div>
</body>
</html>`;
}

/**
 * Serve a DB-snapshot fallback preview for server-stack agentic projects when
 * the Fly.io container layer is not configured in this environment.
 *
 * Sets `X-MustaFlow-Preview-State: db-fallback` so the frontend can detect
 * the degraded state and show appropriate guidance.
 */
export async function serveProjectFilesPreview(
  res: Response,
  projectId: number,
  stack: string | null,
): Promise<void> {
  const files = await db
    .select({ path: projectFilesTable.path })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId))
    .catch(() => []);

  res
    .status(200)
    .type("text/html")
    .setHeader("Cache-Control", "no-store, must-revalidate")
    .setHeader("X-MustaFlow-Preview-State", "db-fallback")
    .send(buildFallbackPage(projectId, files.length, stack));
}
