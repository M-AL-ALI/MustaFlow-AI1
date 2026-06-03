import { eq } from "drizzle-orm";
import { db, projectFilesTable, projectGithubConnectionsTable } from "@workspace/db";
import { encryptionService } from "./encryption";
import { logger } from "./logger";

// ─── Low-level GitHub fetch helper ───────────────────────────────────────────

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

// ─── pushFiles — atomic multi-file commit via Trees API ──────────────────────

export interface PushFilesArgs {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  commitMessage: string;
  files: Array<{ path: string; content: string }>;
}

export async function pushFiles(args: PushFilesArgs): Promise<{ sha: string; repoUrl: string }> {
  const { token, owner, repo, branch, commitMessage, files } = args;

  let baseTreeSha = "";
  let parentSha: string | null = null;
  let existingRepoPaths = new Set<string>();

  try {
    const refData = (await githubFetch(
      `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      token,
    )) as { object: { sha: string } };
    parentSha = refData.object.sha;
    const commitData = (await githubFetch(
      `/repos/${owner}/${repo}/git/commits/${parentSha}`,
      token,
    )) as { tree: { sha: string } };
    baseTreeSha = commitData.tree.sha;

    try {
      const existingTree = (await githubFetch(
        `/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`,
        token,
      )) as { sha: string; tree: Array<{ path: string; type: string }> };
      existingRepoPaths = new Set(
        existingTree.tree.filter((e) => e.type === "blob").map((e) => e.path),
      );
    } catch {
      // non-fatal — tree fetch failure means we can't clean up deleted files
    }
  } catch {
    // Branch doesn't exist yet — first push
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

  for (const repoPath of existingRepoPaths) {
    if (!projectFilePaths.has(repoPath)) {
      treeItems.push({ path: repoPath, mode: "100644", type: "blob", sha: null });
    }
  }

  const treePayload: Record<string, unknown> = { tree: treeItems };
  if (baseTreeSha) treePayload.base_tree = baseTreeSha;

  const newTree = (await githubFetch(`/repos/${owner}/${repo}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify(treePayload),
  })) as { sha: string };

  const commitPayload: Record<string, unknown> = {
    message: commitMessage,
    tree: newTree.sha,
  };
  if (parentSha) commitPayload.parents = [parentSha];

  const newCommit = (await githubFetch(`/repos/${owner}/${repo}/git/commits`, token, {
    method: "POST",
    body: JSON.stringify(commitPayload),
  })) as { sha: string };

  try {
    await githubFetch(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommit.sha, force: true }),
    });
  } catch {
    await githubFetch(`/repos/${owner}/${repo}/git/refs`, token, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }),
    });
  }

  return {
    sha: newCommit.sha,
    repoUrl: `https://github.com/${owner}/${repo}`,
  };
}

// ─── autoCommitProjectFiles ───────────────────────────────────────────────────
//
// Called after a successful build or refine. Checks whether this project has a
// GitHub connection with a selected repository and, if so, pushes all current
// project files as a new commit. Entirely non-fatal: any failure is logged at
// warn level and returned as a string error message (the caller may surface it
// as a non-blocking build report warning).

export async function autoCommitProjectFiles(
  projectId: number,
  projectName: string,
): Promise<{ ok: true; sha: string | null } | { ok: false; message: string }> {
  const [conn] = await db
    .select()
    .from(projectGithubConnectionsTable)
    .where(eq(projectGithubConnectionsTable.projectId, projectId))
    .limit(1);

  if (!conn?.repositoryOwner || !conn?.repositoryName) {
    return { ok: true, sha: null };
  }

  let token: string;
  try {
    token = encryptionService.decrypt(conn.encryptedToken);
  } catch {
    return { ok: false, message: "GitHub auto-commit: could not decrypt token — reconnect." };
  }

  const files = await db
    .select({ path: projectFilesTable.path, content: projectFilesTable.content })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  if (files.length === 0) {
    return { ok: true, sha: null };
  }

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const commitMessage = `Build: ${projectName} — ${timestamp}`;

  try {
    await db
      .update(projectGithubConnectionsTable)
      .set({ syncStatus: "syncing", updatedAt: new Date() })
      .where(eq(projectGithubConnectionsTable.projectId, projectId));

    const { sha } = await pushFiles({
      token,
      owner: conn.repositoryOwner,
      repo: conn.repositoryName,
      branch: conn.defaultBranch ?? "main",
      commitMessage,
      files,
    });

    await db
      .update(projectGithubConnectionsTable)
      .set({ syncStatus: "idle", lastSyncAt: new Date(), updatedAt: new Date() })
      .where(eq(projectGithubConnectionsTable.projectId, projectId));

    logger.info(
      {
        projectId,
        repo: `${conn.repositoryOwner}/${conn.repositoryName}`,
        filesCount: files.length,
        sha,
      },
      "GitHub auto-commit succeeded",
    );
    return { ok: true, sha };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.warn({ err, projectId }, "GitHub auto-commit failed (non-fatal)");
    await db
      .update(projectGithubConnectionsTable)
      .set({ syncStatus: "error", updatedAt: new Date() })
      .where(eq(projectGithubConnectionsTable.projectId, projectId))
      .catch(() => {});
    return { ok: false, message: `GitHub auto-commit failed: ${message}` };
  }
}
