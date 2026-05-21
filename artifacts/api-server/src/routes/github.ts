import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, projectFilesTable, projectGithubConnectionsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";
import { encryptionService } from "../lib/encryption";

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
      const message = err instanceof Error ? err.message : "GitHub connect failed";
      logger.warn({ err, projectId }, "GitHub connect failed");
      res.status(400).json({ error: message });
    }
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
    const commitMessage = body.commitMessage?.trim() || "Push from MustaFlow AI";

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
      const message = err instanceof Error ? err.message : "GitHub push failed";
      logger.error({ err, projectId }, "GitHub push failed");
      await db
        .update(projectGithubConnectionsTable)
        .set({ syncStatus: "error", updatedAt: new Date() })
        .where(eq(projectGithubConnectionsTable.projectId, projectId));
      res.status(400).json({ error: message });
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
      const message = err instanceof Error ? err.message : "Failed to create branch";
      res.status(400).json({ error: message });
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
          body: body.body ?? "Created via MustaFlow AI",
          head: body.head,
          base,
        }),
      })) as GithubApiPr;

      logger.info({ projectId, owner, repo, pr: pr.number }, "PR opened");
      res.json({ prUrl: pr.html_url, prNumber: pr.number, title: pr.title });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to open pull request";
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
