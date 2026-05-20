import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, projectFilesTable, secretsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";
import { encryptionService } from "../lib/encryption";

const router: IRouter = Router();

interface GithubPushBody {
  token?: string;
  repo: string;
  owner?: string;
  branch?: string;
  private?: boolean;
  commitMessage?: string;
}

interface GithubApiUser {
  login: string;
}

interface GithubApiRef {
  object: { sha: string };
}

interface GithubApiTree {
  sha: string;
}

interface GithubApiTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface GithubApiTreeResponse {
  sha: string;
  tree: GithubApiTreeEntry[];
  truncated?: boolean;
}

interface GithubApiCommit {
  sha: string;
}

interface GithubApiUpdateRef {
  object: { sha: string };
}

interface GithubApiRepo {
  html_url: string;
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
  const body = await res.json() as unknown;
  if (!res.ok) {
    const msg =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : `GitHub API error ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

router.post(
  "/projects/:id/github/push",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = req.body as GithubPushBody;

    if (!body.repo || typeof body.repo !== "string") {
      res.status(400).json({ error: "repo is required" });
      return;
    }

    // Resolve token: use provided value or fall back to stored GITHUB_TOKEN secret
    let token = body.token?.trim() ?? "";
    if (!token) {
      const stored = await db
        .select({ valueEncrypted: secretsTable.valueEncrypted })
        .from(secretsTable)
        .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "GITHUB_TOKEN")))
        .limit(1);
      if (stored[0]) {
        try {
          token = encryptionService.decrypt(stored[0].valueEncrypted);
        } catch {
          // ignore decryption errors
        }
      }
    }

    if (!token) {
      res.status(400).json({ error: "A GitHub personal access token is required. Enter one below or save it as the GITHUB_TOKEN project secret." });
      return;
    }
    const repoName = body.repo.trim().replace(/[^a-zA-Z0-9_.-]/g, "-");
    const branch = (body.branch ?? "main").trim();
    const commitMessage =
      body.commitMessage?.trim() || "Push from MustaFlow AI";
    const isPrivate = body.private !== false;

    try {
      // 1. Resolve the repo owner (defaults to authenticated user)
      let owner = body.owner?.trim();
      if (!owner) {
        const user = (await githubFetch("/user", token)) as GithubApiUser;
        owner = user.login;
      }

      // 2. Load all project files
      const files = await db
        .select({ path: projectFilesTable.path, content: projectFilesTable.content, mimeType: projectFilesTable.mimeType })
        .from(projectFilesTable)
        .where(eq(projectFilesTable.projectId, projectId));

      if (files.length === 0) {
        res.status(400).json({ error: "Project has no files to push. Build something first." });
        return;
      }

      // 3. Ensure repo exists (create if not)
      let repoUrl = "";
      let repoCreated = false;
      try {
        const existingRepo = (await githubFetch(`/repos/${owner}/${repoName}`, token)) as GithubApiRepo;
        repoUrl = existingRepo.html_url;
      } catch {
        // Repo doesn't exist — create it
        const newRepo = (await githubFetch("/user/repos", token, {
          method: "POST",
          body: JSON.stringify({ name: repoName, private: isPrivate, auto_init: true }),
        })) as GithubApiRepo;
        repoUrl = newRepo.html_url;
        repoCreated = true;
        // Small delay for GitHub to initialise the repo
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      }

      // 4. Get the current HEAD commit SHA for the branch
      let baseTreeSha: string;
      let parentSha: string | null = null;
      let existingRepoFiles: Set<string> = new Set();
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

        // Fetch the existing tree so we can detect files deleted from the project
        try {
          const existingTree = (await githubFetch(
            `/repos/${owner}/${repoName}/git/trees/${baseTreeSha}?recursive=1`,
            token,
          )) as GithubApiTreeResponse;
          existingRepoFiles = new Set(
            existingTree.tree
              .filter((e) => e.type === "blob")
              .map((e) => e.path),
          );
        } catch {
          // Non-fatal: if we can't list the tree, just push without deletion
        }
      } catch {
        // Branch doesn't exist — will create from empty tree
        baseTreeSha = "";
      }

      // 5. Build the tree payload (blobs for each file)
      const projectFilePaths = new Set(files.map((f) => f.path));

      // Files to add/update
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

      // Files to delete (existed in repo but not in current project)
      for (const repoPath of existingRepoFiles) {
        if (!projectFilePaths.has(repoPath)) {
          treeItems.push({ path: repoPath, mode: "100644", type: "blob", sha: null });
        }
      }

      const treePayload: Record<string, unknown> = { tree: treeItems };
      if (baseTreeSha) treePayload.base_tree = baseTreeSha;

      const newTree = (await githubFetch(
        `/repos/${owner}/${repoName}/git/trees`,
        token,
        { method: "POST", body: JSON.stringify(treePayload) },
      )) as GithubApiTree;

      // 6. Create the commit
      const commitPayload: Record<string, unknown> = {
        message: commitMessage,
        tree: newTree.sha,
      };
      if (parentSha) commitPayload.parents = [parentSha];

      const newCommit = (await githubFetch(
        `/repos/${owner}/${repoName}/git/commits`,
        token,
        { method: "POST", body: JSON.stringify(commitPayload) },
      )) as GithubApiCommit;

      // 7. Update (or create) the branch ref
      try {
        await githubFetch(
          `/repos/${owner}/${repoName}/git/refs/heads/${branch}`,
          token,
          {
            method: "PATCH",
            body: JSON.stringify({ sha: newCommit.sha, force: true }),
          },
        ) as GithubApiUpdateRef;
      } catch {
        // Ref doesn't exist — create it
        await githubFetch(
          `/repos/${owner}/${repoName}/git/refs`,
          token,
          {
            method: "POST",
            body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }),
          },
        );
      }

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
      res.status(400).json({ error: message });
    }
  },
);

export default router;
