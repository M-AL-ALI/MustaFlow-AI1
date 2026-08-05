/**
 * Ora GitHub routes — connect flow, repo listing, and repo-session lifecycle.
 *
 * Two routers:
 *  - oraGithubCallbackRouter: the OAuth callback (public mount; authenticated
 *    by the signed HMAC state, which carries the user id — works from the
 *    website and from the mobile in-app browser without a cookie session).
 *  - oraGithubRouter: everything else (authed mount, req.userId).
 *
 * HARD BOUNDARY: read-only. No route here (or anywhere in Ora) writes to
 * GitHub. The OAuth token is encrypted at rest and never returned to clients.
 */
import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, oraRepoSessionsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  buildOraAuthorizeUrl,
  checkOraGithubConnectionHealth,
  deleteOraGithubConnection,
  describeOraGithubProblem,
  exchangeOraOAuthCode,
  fetchGithubUser,
  fetchRepoMeta,
  getOraGithubToken,
  isOraGithubConfigured,
  listGithubRepos,
  oraGithubRedirectUri,
  saveOraGithubConnection,
  signOraOAuthState,
  verifyOraOAuthState,
  type OraGithubProblem,
} from "../lib/public-ai/repo-github-auth";
import { destroyRepoWorkspace } from "../lib/public-ai/repo-workspace";

export const oraGithubCallbackRouter = Router();
export const oraGithubRouter = Router();

function githubProblemStatus(problem: OraGithubProblem): number {
  if (problem.tokenHealth === "oauth_not_configured") return 503;
  if (problem.tokenHealth === "not_connected") return 401;
  if (problem.tokenHealth === "rate_limited") return 429;
  if (problem.tokenHealth === "token_invalid" || problem.tokenHealth === "token_unreadable") {
    return 401;
  }
  if (problem.tokenHealth === "access_denied") return 403;
  if (problem.status === 404) return 404;
  return 502;
}

function githubProblemBody(problem: OraGithubProblem) {
  return {
    error: problem.message,
    detail: problem.detail,
    tokenHealth: problem.tokenHealth,
    retryable: problem.retryable,
    reconnectRequired: problem.reconnectRequired,
    status: problem.status ?? null,
  };
}

const MOBILE_DONE_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub connected</title></head>
<body style="background:#0a0a0a;color:#e5e5e5;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;padding:32px"><div style="font-size:40px">✓</div>
<h2 style="margin:12px 0 6px">GitHub connected</h2>
<p style="color:#9a9a9a;margin:0">You can close this window and return to Ora.</p></div></body></html>`;

function callbackErrorRedirect(
  res: Parameters<Parameters<typeof oraGithubCallbackRouter.get>[1]>[1],
  platform: string,
  reason: string,
) {
  logger.warn({ reason }, "ora-github: oauth callback rejected");
  if (platform === "mobile") {
    res
      .status(400)
      .send(MOBILE_DONE_HTML.replace("✓", "✕").replace("GitHub connected", "Connection failed"));
    return;
  }
  res.redirect("/ora/settings?github=error");
}

// GET /ora/github/oauth/callback — public; authenticated by signed state.
oraGithubCallbackRouter.get("/ora/github/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !state) return callbackErrorRedirect(res, "web", "missing code/state");
  const verified = verifyOraOAuthState(state);
  if (!verified.ok) return callbackErrorRedirect(res, "web", verified.reason);
  const { uid, platform } = verified.payload;
  try {
    const exchanged = await exchangeOraOAuthCode(code, oraGithubRedirectUri(req));
    if (!exchanged.ok) return callbackErrorRedirect(res, platform, exchanged.reason);
    const user = await fetchGithubUser(exchanged.token);
    await saveOraGithubConnection(uid, exchanged.token, user.login, exchanged.scopes);
    logger.info({ login: user.login }, "ora-github: connection saved");
    if (platform === "mobile") {
      res.send(MOBILE_DONE_HTML);
      return;
    }
    res.redirect("/ora/settings?github=connected");
  } catch (err) {
    logger.error({ err }, "ora-github: callback failed");
    callbackErrorRedirect(res, platform, "exchange failed");
  }
});

// ── Authed routes ────────────────────────────────────────────────────────────

// GET /ora/github/status
oraGithubRouter.get("/ora/github/status", async (req, res) => {
  const userId = req.userId!;
  res.json(await checkOraGithubConnectionHealth(userId));
});

// POST /ora/github/connect { platform?: "web" | "mobile" } → { url }
oraGithubRouter.post("/ora/github/connect", async (req, res) => {
  const userId = req.userId!;
  if (!isOraGithubConfigured()) {
    res.status(503).json({ error: "GitHub connection is not configured on this server" });
    return;
  }
  const platform = req.body?.platform === "mobile" ? "mobile" : "web";
  const state = signOraOAuthState(userId, platform);
  const url = buildOraAuthorizeUrl(state, oraGithubRedirectUri(req));
  res.json({ url });
});

// DELETE /ora/github — disconnect; also detaches all repo sessions.
oraGithubRouter.delete("/ora/github", async (req, res) => {
  const userId = req.userId!;
  const sessions = await db
    .select({ id: oraRepoSessionsTable.id })
    .from(oraRepoSessionsTable)
    .where(and(eq(oraRepoSessionsTable.userId, userId), eq(oraRepoSessionsTable.status, "active")));
  await db
    .update(oraRepoSessionsTable)
    .set({ status: "detached" })
    .where(eq(oraRepoSessionsTable.userId, userId));
  for (const s of sessions) {
    await destroyRepoWorkspace(s.id).catch(() => {});
  }
  await deleteOraGithubConnection(userId);
  res.json({ ok: true });
});

// GET /ora/github/repos — dropdown data.
oraGithubRouter.get("/ora/github/repos", async (req, res) => {
  const userId = req.userId!;
  const token = await getOraGithubToken(userId);
  if (!token) {
    const health = await checkOraGithubConnectionHealth(userId);
    const problem: OraGithubProblem = {
      tokenHealth: health.tokenHealth,
      message: health.connected
        ? "GitHub authorization needs attention"
        : "GitHub is not connected",
      detail:
        health.detail ??
        "Connect GitHub in Settings before Ora can list repositories for analysis.",
      retryable: health.retryable,
      reconnectRequired: health.reconnectRequired,
    };
    res.status(health.available === false ? 503 : githubProblemStatus(problem)).json({
      ...githubProblemBody(problem),
      available: health.available,
      connected: health.connected,
      healthy: health.healthy,
      login: health.login,
    });
    return;
  }
  try {
    const repos = await listGithubRepos(token);
    res.json({ repos });
  } catch (err) {
    const problem = describeOraGithubProblem(err);
    logger.warn({ err }, "ora-github: repo list failed");
    res.status(githubProblemStatus(problem)).json(githubProblemBody(problem));
  }
});

const selectRepoSchema = z.object({
  owner: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9-]+$/),
  repo: z
    .string()
    .min(1)
    .max(150)
    .regex(/^[A-Za-z0-9._-]+$/),
  conversationId: z.string().max(120).nullable().optional(),
});

// POST /ora/github/repo-session — select a repo for analysis.
oraGithubRouter.post("/ora/github/repo-session", async (req, res) => {
  const userId = req.userId!;
  const parsed = selectRepoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid repo selection" });
    return;
  }
  const token = await getOraGithubToken(userId);
  if (!token) {
    const health = await checkOraGithubConnectionHealth(userId);
    const problem: OraGithubProblem = {
      tokenHealth: health.tokenHealth,
      message: health.connected
        ? "GitHub authorization needs attention"
        : "GitHub is not connected",
      detail:
        health.detail ?? "Connect GitHub in Settings before selecting a repository for analysis.",
      retryable: health.retryable,
      reconnectRequired: health.reconnectRequired,
    };
    res.status(health.available === false ? 503 : githubProblemStatus(problem)).json({
      ...githubProblemBody(problem),
      available: health.available,
      connected: health.connected,
      healthy: health.healthy,
      login: health.login,
    });
    return;
  }
  const { owner, repo, conversationId } = parsed.data;
  let meta: { defaultBranch: string; branchSha: string; treeSha: string };
  try {
    meta = await fetchRepoMeta(token, owner, repo);
  } catch (err) {
    const problem = describeOraGithubProblem(err);
    logger.warn({ err, owner, repo }, "ora-github: repo metadata lookup failed");
    res.status(githubProblemStatus(problem)).json({
      ...githubProblemBody(problem),
      error: problem.status === 404 ? "Repository not found or not accessible" : problem.message,
    });
    return;
  }
  // One active session per user+conversation scope: detach previous ones.
  const previous = await db
    .select({ id: oraRepoSessionsTable.id })
    .from(oraRepoSessionsTable)
    .where(and(eq(oraRepoSessionsTable.userId, userId), eq(oraRepoSessionsTable.status, "active")));
  const conversationKey = conversationId ?? null;
  const toDetach = previous.length > 0 ? previous : [];
  if (toDetach.length > 0) {
    await db
      .update(oraRepoSessionsTable)
      .set({ status: "detached" })
      .where(
        and(eq(oraRepoSessionsTable.userId, userId), eq(oraRepoSessionsTable.status, "active")),
      );
    for (const s of toDetach) await destroyRepoWorkspace(s.id).catch(() => {});
  }
  const inserted = await db
    .insert(oraRepoSessionsTable)
    .values({
      userId,
      conversationId: conversationKey,
      owner,
      repo,
      ref: "",
      defaultBranch: meta.defaultBranch,
      branchSha: meta.branchSha,
      treeSha: meta.treeSha,
      status: "active",
    })
    .returning({ id: oraRepoSessionsTable.id });
  const session = inserted[0]!;
  logger.info({ owner, repo, sessionId: session.id }, "ora-github: repo session created");
  res.status(201).json({
    session: {
      id: session.id,
      owner,
      repo,
      fullName: `${owner}/${repo}`,
      defaultBranch: meta.defaultBranch,
      branchSha: meta.branchSha,
    },
  });
});

// GET /ora/github/repo-session — the user's active session (if any).
oraGithubRouter.get("/ora/github/repo-session", async (req, res) => {
  const userId = req.userId!;
  const rows = await db
    .select()
    .from(oraRepoSessionsTable)
    .where(and(eq(oraRepoSessionsTable.userId, userId), eq(oraRepoSessionsTable.status, "active")))
    .limit(1);
  const row = rows[0];
  res.json({
    session: row
      ? {
          id: row.id,
          owner: row.owner,
          repo: row.repo,
          fullName: `${row.owner}/${row.repo}`,
          defaultBranch: row.defaultBranch,
          branchSha: row.branchSha,
        }
      : null,
  });
});

// DELETE /ora/github/repo-session/:id — detach + destroy workspace.
oraGithubRouter.delete("/ora/github/repo-session/:id", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const updated = await db
    .update(oraRepoSessionsTable)
    .set({ status: "detached" })
    .where(and(eq(oraRepoSessionsTable.id, id), eq(oraRepoSessionsTable.userId, userId)))
    .returning({ id: oraRepoSessionsTable.id });
  if (updated.length === 0) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await destroyRepoWorkspace(id).catch(() => {});
  res.json({ ok: true });
});
