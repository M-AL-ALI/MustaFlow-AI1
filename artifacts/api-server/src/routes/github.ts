import { Router, type IRouter } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db, projectsTable, projectFilesTable, projectGithubConnectionsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";
import { encryptionService } from "../lib/encryption";
import { githubProviderErrorMessage } from "@workspace/ora-contracts";
import {
  buildAuthorizeUrl,
  buildCallbackUrl,
  exchangeCodeForToken,
  getGithubOAuthConfig,
  isGithubOAuthEnabled,
  signOAuthState,
  verifyOAuthState,
} from "../lib/githubOAuth";
import { acquireProjectLifecycleSession } from "../lib/project-lifecycle";

const router: IRouter = Router();

// ── GitHub API helpers ────────────────────────────────────────────────────────

interface GithubApiUser {
  login: string;
}
interface GithubApiRepo {
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  description: string | null;
}
interface GithubApiRef {
  object: { sha: string };
}
interface GithubApiTree {
  sha: string;
}
interface GithubApiTreeEntry {
  path: string;
  type: string;
}
interface GithubApiTreeResponse {
  sha: string;
  tree: GithubApiTreeEntry[];
}
interface GithubApiCommit {
  sha: string;
}
interface GithubApiBranch {
  name: string;
  commit: { sha: string };
}
interface GithubApiPr {
  html_url: string;
  number: number;
  title: string;
}

async function githubFetch(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  const body = (await res.json()) as unknown;
  if (!res.ok) {
    const msg =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : `GitHub API error ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

async function getStoredToken(projectId: number): Promise<string | null> {
  const rows = await db
    .select({ encryptedToken: projectGithubConnectionsTable.encryptedToken })
    .from(projectGithubConnectionsTable)
    .where(eq(projectGithubConnectionsTable.projectId, projectId))
    .limit(1);
  if (!rows[0]) return null;
  try {
    return encryptionService.decrypt(rows[0].encryptedToken);
  } catch {
    return null;
  }
}

// ── GET /api/projects/:id/github/status ──────────────────────────────────────

router.get(
  "/projects/:id/github/status",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const rows = await db
      .select({
        id: projectGithubConnectionsTable.id,
        githubAccountName: projectGithubConnectionsTable.githubAccountName,
        repositoryOwner: projectGithubConnectionsTable.repositoryOwner,
        repositoryName: projectGithubConnectionsTable.repositoryName,
        defaultBranch: projectGithubConnectionsTable.defaultBranch,
        lastSyncAt: projectGithubConnectionsTable.lastSyncAt,
        syncStatus: projectGithubConnectionsTable.syncStatus,
        createdAt: projectGithubConnectionsTable.createdAt,
      })
      .from(projectGithubConnectionsTable)
      .where(eq(projectGithubConnectionsTable.projectId, projectId))
      .limit(1);

    if (!rows[0]) {
      res.json({ connected: false });
      return;
    }
    res.json({ connected: true, connection: rows[0] });
  },
);

// ── POST /api/projects/:id/github/connect ────────────────────────────────────

router.post(
  "/projects/:id/github/connect",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const userId = req.userId ?? "";
    const body = req.body as { token?: string };

    if (!body.token?.trim()) {
      res.status(400).json({ error: "token is required" });
      return;
    }
    const token = body.token.trim();

    try {
      const user = (await githubFetch("/user", token)) as GithubApiUser;
      const encrypted = encryptionService.encrypt(token);

      await db
        .delete(projectGithubConnectionsTable)
        .where(eq(projectGithubConnectionsTable.projectId, projectId));

      await db.insert(projectGithubConnectionsTable).values({
        projectId,
        ownerId: userId,
        githubAccountName: user.login,
        encryptedToken: encrypted,
        syncStatus: "idle",
      });

      logger.info({ projectId, login: user.login }, "GitHub connected");
      res.json({ connected: true, githubAccountName: user.login });
    } catch (err) {
      logger.warn({ err, projectId }, "GitHub connect failed");
      res.status(400).json({ error: githubProviderErrorMessage(err) });
    }
  },
);

// ── GET /api/projects/:id/github/oauth/start ─────────────────────────────────
// Initiates the GitHub OAuth flow. Redirects the browser to GitHub's
// authorization page. The user must be signed in and own the project.

router.get(
  "/projects/:id/github/oauth/start",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const userId = req.userId ?? "";

    const config = getGithubOAuthConfig();
    if (!config) {
      res.status(503).json({
        error:
          "GitHub OAuth is not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET, or use a personal access token instead.",
      });
      return;
    }

    try {
      const state = signOAuthState(projectId, userId);
      const redirectUri = buildCallbackUrl({
        protocol: (req.get("x-forwarded-proto") ?? req.protocol) || "https",
        host: req.get("host") ?? "",
        projectId,
      });
      // When ?switch=1 is passed, force GitHub to re-show the account picker
      // rather than silently re-using the currently signed-in browser session.
      const switchAccount =
        req.query.switch === "1" ||
        req.query.switch === "true" ||
        req.query.prompt === "select_account";
      const loginHint = typeof req.query.login === "string" ? req.query.login : undefined;
      const url = buildAuthorizeUrl({
        clientId: config.clientId,
        redirectUri,
        state,
        prompt: switchAccount ? "select_account" : undefined,
        login: loginHint,
      });
      res.redirect(302, url);
    } catch (err) {
      logger.error({ err, projectId }, "GitHub OAuth start failed");
      res.status(500).json({ error: "Failed to start GitHub OAuth flow" });
    }
  },
);

// ── GET /api/projects/:id/github/oauth/callback ──────────────────────────────
// GitHub redirects here with ?code & ?state. We verify ownership inline so
// failures can redirect back to the frontend with an error query string rather
// than returning JSON 401/403.

function frontendReturnUrl(
  req: { protocol: string; get(name: string): string | undefined },
  projectId: number,
  params: Record<string, string>,
): string {
  const proto = (req.get("x-forwarded-proto") ?? req.protocol) || "https";
  const host = req.get("host") ?? "";
  const qs = new URLSearchParams({ tab: "github", ...params }).toString();
  return `${proto}://${host}/projects/${projectId}?${qs}`;
}

router.get("/projects/:id/github/oauth/callback", async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const stateParam = typeof req.query.state === "string" ? req.query.state : "";
  const errorParam = typeof req.query.error === "string" ? req.query.error : "";

  // User denied or GitHub-reported error
  if (errorParam) {
    const desc =
      typeof req.query.error_description === "string" ? req.query.error_description : errorParam;
    res.redirect(302, frontendReturnUrl(req, projectId, { github: "error", reason: desc }));
    return;
  }

  if (!code || !stateParam) {
    res.redirect(
      302,
      frontendReturnUrl(req, projectId, { github: "error", reason: "Missing code or state" }),
    );
    return;
  }

  const verified = verifyOAuthState(stateParam);
  if (!verified.ok) {
    logger.warn({ projectId, reason: verified.reason }, "GitHub OAuth state verification failed");
    res.redirect(
      302,
      frontendReturnUrl(req, projectId, {
        github: "error",
        reason: "Invalid or expired sign-in. Please try again.",
      }),
    );
    return;
  }
  if (verified.payload.pid !== projectId) {
    res.redirect(
      302,
      frontendReturnUrl(req, projectId, { github: "error", reason: "State / project mismatch" }),
    );
    return;
  }

  // Inline ownership check — the user must still be the project owner.
  const userId = req.userId ?? "";
  if (!userId) {
    // Not signed in — bounce to sign-in, which will return to this URL.
    const proto = (req.get("x-forwarded-proto") ?? req.protocol) || "https";
    const host = req.get("host") ?? "";
    const returnTo = `${proto}://${host}${req.originalUrl}`;
    res.redirect(302, `/sign-in?redirect_url=${encodeURIComponent(returnTo)}`);
    return;
  }
  if (userId !== verified.payload.uid) {
    res.redirect(
      302,
      frontendReturnUrl(req, projectId, {
        github: "error",
        reason: "Signed-in user does not match the original request",
      }),
    );
    return;
  }

  const proj = await db
    .select({ id: projectsTable.id, ownerId: projectsTable.ownerId })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)))
    .limit(1);
  if (!proj[0]) {
    res.redirect(
      302,
      frontendReturnUrl(req, projectId, { github: "error", reason: "Project not found" }),
    );
    return;
  }
  if (proj[0].ownerId !== userId) {
    res.redirect(
      302,
      frontendReturnUrl(req, projectId, { github: "error", reason: "You do not own this project" }),
    );
    return;
  }

  const config = getGithubOAuthConfig();
  if (!config) {
    res.redirect(
      302,
      frontendReturnUrl(req, projectId, {
        github: "error",
        reason: "GitHub OAuth is not configured",
      }),
    );
    return;
  }

  // OAuth callbacks are mutating GETs whose project identity comes from the
  // signed state. Hold the lifecycle fence across token exchange and the final
  // connection receipt so Trash cannot race a late callback.
  const lifecycleSession = await acquireProjectLifecycleSession(projectId);
  if (!lifecycleSession) {
    res.redirect(
      302,
      frontendReturnUrl(req, projectId, { github: "error", reason: "Project not found" }),
    );
    return;
  }

  try {
    const redirectUri = buildCallbackUrl({
      protocol: (req.get("x-forwarded-proto") ?? req.protocol) || "https",
      host: req.get("host") ?? "",
      projectId,
    });
    const token = await exchangeCodeForToken({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri,
    });

    // Fetch GitHub user info to learn the login name
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const userJson = (await userRes.json()) as { login?: string; message?: string };
    if (!userRes.ok || !userJson.login) {
      throw new Error(userJson.message ?? "Could not read GitHub user");
    }

    const encrypted = encryptionService.encrypt(token.accessToken);

    // Preserve any previously selected repo + branch so re-connecting via
    // OAuth (e.g. to refresh the token) doesn't wipe their config.
    const existing = await db
      .select({
        repositoryOwner: projectGithubConnectionsTable.repositoryOwner,
        repositoryName: projectGithubConnectionsTable.repositoryName,
        defaultBranch: projectGithubConnectionsTable.defaultBranch,
      })
      .from(projectGithubConnectionsTable)
      .where(eq(projectGithubConnectionsTable.projectId, projectId))
      .limit(1);

    await db
      .delete(projectGithubConnectionsTable)
      .where(eq(projectGithubConnectionsTable.projectId, projectId));

    await db.insert(projectGithubConnectionsTable).values({
      projectId,
      ownerId: userId,
      githubAccountName: userJson.login,
      encryptedToken: encrypted,
      syncStatus: "idle",
      repositoryOwner: existing[0]?.repositoryOwner ?? null,
      repositoryName: existing[0]?.repositoryName ?? null,
      defaultBranch: existing[0]?.defaultBranch ?? "main",
    });

    logger.info({ projectId, login: userJson.login }, "GitHub connected via OAuth");
    res.redirect(302, frontendReturnUrl(req, projectId, { github: "connected" }));
  } catch (err) {
    logger.warn({ err, projectId }, "GitHub OAuth callback failed");
    res.redirect(
      302,
      frontendReturnUrl(req, projectId, {
        github: "error",
        reason: githubProviderErrorMessage(err),
      }),
    );
  } finally {
    await lifecycleSession.release();
  }
});

// ── GET /api/projects/:id/github/oauth/config ────────────────────────────────
// Lightweight status endpoint so the frontend can decide whether to show the
// "Connect with GitHub" button or fall back to the PAT form.

router.get(
  "/projects/:id/github/oauth/config",
  requireProjectOwnership,
  async (_req, res): Promise<void> => {
    res.json({ enabled: isGithubOAuthEnabled() });
  },
);

// ── POST /api/projects/:id/github/disconnect ─────────────────────────────────

router.post(
  "/projects/:id/github/disconnect",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    await db
      .delete(projectGithubConnectionsTable)
      .where(eq(projectGithubConnectionsTable.projectId, projectId));
    logger.info({ projectId }, "GitHub disconnected");
    res.json({ disconnected: true });
  },
);

// ── GET /api/projects/:id/github/repositories ─────────────────────────────────

router.get(
  "/projects/:id/github/repositories",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const token = await getStoredToken(projectId);
    if (!token) {
      res.status(400).json({ error: "GitHub not connected" });
      return;
    }
    try {
      const page = Number(req.query.page ?? 1);
      const repos = (await githubFetch(
        `/user/repos?per_page=100&page=${page}&sort=updated&type=all`,
        token,
      )) as GithubApiRepo[];
      res.json({
        repositories: repos.map((r) => ({
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          htmlUrl: r.html_url,
          defaultBranch: r.default_branch,
          description: r.description,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list repositories";
      res.status(400).json({ error: message });
    }
  },
);

// ── POST /api/projects/:id/github/select-repository ──────────────────────────

router.post(
  "/projects/:id/github/select-repository",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = req.body as {
      repositoryOwner?: string;
      repositoryName?: string;
      defaultBranch?: string;
    };
    if (!body.repositoryOwner || !body.repositoryName) {
      res.status(400).json({ error: "repositoryOwner and repositoryName are required" });
      return;
    }
    await db
      .update(projectGithubConnectionsTable)
      .set({
        repositoryOwner: body.repositoryOwner,
        repositoryName: body.repositoryName,
        defaultBranch: body.defaultBranch ?? "main",
        updatedAt: new Date(),
      })
      .where(eq(projectGithubConnectionsTable.projectId, projectId));
    res.json({ selected: true });
  },
);

// ── POST /api/projects/:id/github/push ───────────────────────────────────────

router.post(
  "/projects/:id/github/push",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = req.body as {
      branch?: string;
      commitMessage?: string;
      repositoryOwner?: string;
      repositoryName?: string;
    };

    const conn = await db
      .select()
      .from(projectGithubConnectionsTable)
      .where(eq(projectGithubConnectionsTable.projectId, projectId))
      .limit(1);

    if (!conn[0]) {
      res.status(400).json({ error: "GitHub not connected. Connect first." });
      return;
    }

    let token: string;
    try {
      token = encryptionService.decrypt(conn[0].encryptedToken);
    } catch {
      res.status(400).json({ error: "Stored GitHub token is unreadable. Reconnect." });
      return;
    }

    const owner = body.repositoryOwner ?? conn[0].repositoryOwner;
    const repoName = body.repositoryName ?? conn[0].repositoryName;

    if (!owner || !repoName) {
      res.status(400).json({ error: "No repository selected. Select one first." });
      return;
    }

    const branch = body.branch ?? conn[0].defaultBranch;
    const commitMessage = body.commitMessage?.trim() || "Push from NabuFlow";

    try {
      await db
        .update(projectGithubConnectionsTable)
        .set({ syncStatus: "syncing", updatedAt: new Date() })
        .where(eq(projectGithubConnectionsTable.projectId, projectId));

      const files = await db
        .select({ path: projectFilesTable.path, content: projectFilesTable.content })
        .from(projectFilesTable)
        .where(eq(projectFilesTable.projectId, projectId));

      if (files.length === 0) {
        res.status(400).json({ error: "Project has no files to push. Build something first." });
        return;
      }

      // Ensure repo exists
      let repoUrl = "";
      let repoCreated = false;
      try {
        const existing = (await githubFetch(`/repos/${owner}/${repoName}`, token)) as GithubApiRepo;
        repoUrl = existing.html_url;
      } catch {
        const created = (await githubFetch("/user/repos", token, {
          method: "POST",
          body: JSON.stringify({ name: repoName, private: true, auto_init: true }),
        })) as GithubApiRepo;
        repoUrl = created.html_url;
        repoCreated = true;
        await new Promise<void>((r) => setTimeout(r, 2000));
      }

      // Get HEAD
      let baseTreeSha = "";
      let parentSha: string | null = null;
      let existingRepoFiles = new Set<string>();
      try {
        const refData = (await githubFetch(
          `/repos/${owner}/${repoName}/git/refs/heads/${branch}`,
          token,
        )) as GithubApiRef;
        parentSha = refData.object.sha;
        const commitData = (await githubFetch(
          `/repos/${owner}/${repoName}/git/commits/${parentSha}`,
          token,
        )) as { tree: { sha: string } };
        baseTreeSha = commitData.tree.sha;
        try {
          const existingTree = (await githubFetch(
            `/repos/${owner}/${repoName}/git/trees/${baseTreeSha}?recursive=1`,
            token,
          )) as GithubApiTreeResponse;
          existingRepoFiles = new Set(
            existingTree.tree.filter((e) => e.type === "blob").map((e) => e.path),
          );
        } catch {
          // non-fatal
        }
      } catch {
        // Branch doesn't exist yet
      }

      const projectFilePaths = new Set(files.map((f) => f.path));
      const treeItems: Array<{
        path: string;
        mode: string;
        type: string;
        content?: string;
        sha: null | undefined;
      }> = files.map((f) => ({
        path: f.path,
        mode: "100644",
        type: "blob",
        content: f.content,
        sha: undefined,
      }));
      for (const repoPath of existingRepoFiles) {
        if (!projectFilePaths.has(repoPath)) {
          treeItems.push({ path: repoPath, mode: "100644", type: "blob", sha: null });
        }
      }

      const treePayload: Record<string, unknown> = { tree: treeItems };
      if (baseTreeSha) treePayload.base_tree = baseTreeSha;
      const newTree = (await githubFetch(`/repos/${owner}/${repoName}/git/trees`, token, {
        method: "POST",
        body: JSON.stringify(treePayload),
      })) as GithubApiTree;

      const commitPayload: Record<string, unknown> = { message: commitMessage, tree: newTree.sha };
      if (parentSha) commitPayload.parents = [parentSha];
      const newCommit = (await githubFetch(`/repos/${owner}/${repoName}/git/commits`, token, {
        method: "POST",
        body: JSON.stringify(commitPayload),
      })) as GithubApiCommit;

      try {
        await githubFetch(`/repos/${owner}/${repoName}/git/refs/heads/${branch}`, token, {
          method: "PATCH",
          body: JSON.stringify({ sha: newCommit.sha, force: true }),
        });
      } catch {
        await githubFetch(`/repos/${owner}/${repoName}/git/refs`, token, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }),
        });
      }

      await db
        .update(projectGithubConnectionsTable)
        .set({ syncStatus: "idle", lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(projectGithubConnectionsTable.projectId, projectId));

      logger.info(
        { projectId, owner, repoName, branch, filesCount: files.length, repoCreated },
        "GitHub push succeeded",
      );
      res.json({
        repoUrl,
        commitSha: newCommit.sha,
        filesCount: files.length,
        created: repoCreated,
      });
    } catch (err) {
      logger.error({ err, projectId }, "GitHub push failed");
      await db
        .update(projectGithubConnectionsTable)
        .set({ syncStatus: "error", updatedAt: new Date() })
        .where(eq(projectGithubConnectionsTable.projectId, projectId));
      res.status(400).json({ error: githubProviderErrorMessage(err) });
    }
  },
);

// ── POST /api/projects/:id/github/create-branch ──────────────────────────────

router.post(
  "/projects/:id/github/create-branch",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = req.body as { branchName?: string; fromBranch?: string };

    if (!body.branchName?.trim()) {
      res.status(400).json({ error: "branchName is required" });
      return;
    }

    const conn = await db
      .select()
      .from(projectGithubConnectionsTable)
      .where(eq(projectGithubConnectionsTable.projectId, projectId))
      .limit(1);

    if (!conn[0]?.repositoryOwner || !conn[0]?.repositoryName) {
      res.status(400).json({ error: "No repository selected" });
      return;
    }

    let token: string;
    try {
      token = encryptionService.decrypt(conn[0].encryptedToken);
    } catch {
      res.status(400).json({ error: "Stored GitHub token is unreadable. Reconnect." });
      return;
    }

    const { repositoryOwner: owner, repositoryName: repo } = conn[0];
    const baseBranch = body.fromBranch ?? conn[0].defaultBranch;
    const newBranch = body.branchName.trim();

    try {
      const baseRef = (await githubFetch(
        `/repos/${owner}/${repo}/git/refs/heads/${baseBranch}`,
        token,
      )) as GithubApiRef;
      const sha = baseRef.object.sha;

      await githubFetch(`/repos/${owner}/${repo}/git/refs`, token, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha }),
      });

      logger.info({ projectId, owner, repo, newBranch, baseBranch }, "Branch created");
      res.json({ branchName: newBranch, sha });
    } catch (err) {
      res.status(400).json({ error: githubProviderErrorMessage(err) });
    }
  },
);

// ── POST /api/projects/:id/github/open-pr ────────────────────────────────────

router.post(
  "/projects/:id/github/open-pr",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = req.body as {
      title?: string;
      body?: string;
      head?: string;
      base?: string;
    };

    if (!body.head?.trim() || !body.title?.trim()) {
      res.status(400).json({ error: "head branch and title are required" });
      return;
    }

    const conn = await db
      .select()
      .from(projectGithubConnectionsTable)
      .where(eq(projectGithubConnectionsTable.projectId, projectId))
      .limit(1);

    if (!conn[0]?.repositoryOwner || !conn[0]?.repositoryName) {
      res.status(400).json({ error: "No repository selected" });
      return;
    }

    let token: string;
    try {
      token = encryptionService.decrypt(conn[0].encryptedToken);
    } catch {
      res.status(400).json({ error: "Stored GitHub token is unreadable. Reconnect." });
      return;
    }

    const { repositoryOwner: owner, repositoryName: repo } = conn[0];
    const base = body.base ?? conn[0].defaultBranch;

    try {
      const pr = (await githubFetch(`/repos/${owner}/${repo}/pulls`, token, {
        method: "POST",
        body: JSON.stringify({
          title: body.title,
          body: body.body ?? "Created via NabuFlow",
          head: body.head,
          base,
        }),
      })) as GithubApiPr;

      logger.info({ projectId, owner, repo, pr: pr.number }, "PR opened");
      res.json({ prUrl: pr.html_url, prNumber: pr.number, title: pr.title });
    } catch (err) {
      res.status(400).json({ error: githubProviderErrorMessage(err) });
    }
  },
);

// ── GET /api/projects/:id/github/commits ─────────────────────────────────────

interface GithubApiCommitEntry {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  html_url: string;
}

router.get(
  "/projects/:id/github/commits",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const conn = await db
      .select()
      .from(projectGithubConnectionsTable)
      .where(eq(projectGithubConnectionsTable.projectId, projectId))
      .limit(1);

    if (!conn[0]?.repositoryOwner || !conn[0]?.repositoryName) {
      res.status(400).json({ error: "No repository selected" });
      return;
    }

    let token: string;
    try {
      token = encryptionService.decrypt(conn[0].encryptedToken);
    } catch {
      res.status(400).json({ error: "Stored GitHub token is unreadable. Reconnect." });
      return;
    }

    const { repositoryOwner: owner, repositoryName: repo } = conn[0];
    const branch = conn[0].defaultBranch ?? "main";
    const perPage = Math.min(Number(req.query.per_page ?? 20), 50);

    try {
      const commits = (await githubFetch(
        `/repos/${owner}/${repo}/commits?sha=${branch}&per_page=${perPage}`,
        token,
      )) as GithubApiCommitEntry[];

      res.json({
        commits: commits.map((c) => ({
          sha: c.sha,
          shortSha: c.sha.slice(0, 7),
          message: c.commit.message.split("\n")[0] ?? c.commit.message,
          author: c.commit.author?.name ?? "Unknown",
          date: c.commit.author?.date ?? null,
          htmlUrl: c.html_url,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch commits";
      res.status(400).json({ error: message });
    }
  },
);

// ── GET /api/projects/:id/github/sync-status ─────────────────────────────────

router.get(
  "/projects/:id/github/sync-status",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const rows = await db
      .select({
        syncStatus: projectGithubConnectionsTable.syncStatus,
        lastSyncAt: projectGithubConnectionsTable.lastSyncAt,
      })
      .from(projectGithubConnectionsTable)
      .where(eq(projectGithubConnectionsTable.projectId, projectId))
      .limit(1);

    if (!rows[0]) {
      res.status(404).json({ error: "GitHub not connected" });
      return;
    }
    res.json({ syncStatus: rows[0].syncStatus, lastSyncAt: rows[0].lastSyncAt });
  },
);

// ── GET /api/projects/:id/github/branches ─────────────────────────────────────

router.get(
  "/projects/:id/github/branches",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const conn = await db
      .select()
      .from(projectGithubConnectionsTable)
      .where(eq(projectGithubConnectionsTable.projectId, projectId))
      .limit(1);

    if (!conn[0]?.repositoryOwner || !conn[0]?.repositoryName) {
      res.status(400).json({ error: "No repository selected" });
      return;
    }

    let token: string;
    try {
      token = encryptionService.decrypt(conn[0].encryptedToken);
    } catch {
      res.status(400).json({ error: "Stored GitHub token is unreadable. Reconnect." });
      return;
    }

    const { repositoryOwner: owner, repositoryName: repo } = conn[0];

    try {
      const branches = (await githubFetch(
        `/repos/${owner}/${repo}/branches?per_page=100`,
        token,
      )) as GithubApiBranch[];
      res.json({ branches: branches.map((b) => ({ name: b.name, sha: b.commit.sha })) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list branches";
      res.status(400).json({ error: message });
    }
  },
);

export { router as default };

// Keep named export for backward compat if anything imports it
export { router as githubRouter };

// Unused import guard
void and;
