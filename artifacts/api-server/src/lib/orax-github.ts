const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_ORAX_TARBALL_BYTES = 75 * 1024 * 1024;

export type GithubRepoResponse = {
  default_branch: string;
  full_name: string;
  html_url: string;
  private: boolean;
  language: string | null;
  size: number;
  pushed_at: string | null;
};

type GithubUserResponse = {
  login: string;
};

type GithubBranchResponse = {
  commit: {
    sha: string;
  };
};

type GithubRefResponse = {
  object: {
    sha: string;
    type: string;
  };
};

type GithubCommitResponse = {
  sha: string;
  tree: {
    sha: string;
  };
};

type GithubBlobResponse = {
  sha: string;
};

type GithubCreateTreeResponse = {
  sha: string;
};

type GithubPullResponse = {
  number: number;
  html_url: string;
  state: string;
  title: string;
};

type GithubTreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
  url: string;
};

type GithubContentResponse = {
  type: string;
  path: string;
  sha: string;
  size: number;
  encoding?: string;
  content?: string;
  download_url?: string | null;
};

export type GithubTreeResponse = {
  sha: string;
  truncated?: boolean;
  tree: GithubTreeEntry[];
};

export type OraxGithubScanSummary = {
  repo: {
    owner: string;
    name: string;
    fullName: string;
    defaultBranch: string;
    htmlUrl: string;
    private: boolean;
    language: string | null;
    size: number;
    pushedAt: string | null;
  };
  branch: string;
  commitSha: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  languages: Record<string, number>;
  topLevelEntries: Array<{ path: string; type: string }>;
  sampleFiles: string[];
  truncated: boolean;
};

export async function verifyGithubReadOnlyToken(input: {
  owner: string;
  repo: string;
  token: string;
}): Promise<{
  login: string;
  scopes: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
}> {
  const user = await githubJson<GithubUserResponse>("/user", input.token);
  const repo = await githubJson<GithubRepoResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
    input.token,
  );

  return {
    login: user.body.login,
    scopes: normalizeScopes(repo.scopes || user.scopes),
    defaultBranch: repo.body.default_branch,
    private: repo.body.private,
    htmlUrl: repo.body.html_url,
  };
}

export async function scanGithubRepository(input: {
  owner: string;
  repo: string;
  branch?: string | null;
  token?: string;
}): Promise<OraxGithubScanSummary> {
  const repo = await githubJson<GithubRepoResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
    input.token,
  );
  const branchName = input.branch?.trim() || repo.body.default_branch;
  const branch = await githubJson<GithubBranchResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/branches/${encodeURIComponent(branchName)}`,
    input.token,
  );
  const tree = await githubJson<GithubTreeResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/trees/${encodeURIComponent(branch.body.commit.sha)}?recursive=1`,
    input.token,
  );

  return summarizeGithubTree({
    owner: input.owner,
    name: input.repo,
    repo: repo.body,
    branch: branchName,
    commitSha: branch.body.commit.sha,
    tree: tree.body,
  });
}

export async function readGithubRepositoryFiles(input: {
  owner: string;
  repo: string;
  branch: string;
  paths: string[];
  token?: string;
  maxFileBytes: number;
  maxTotalBytes: number;
}): Promise<{
  files: Array<{
    path: string;
    sha: string;
    size: number;
    content: string;
    truncated: boolean;
  }>;
  skipped: Array<{ path: string; reason: string }>;
  totalBytes: number;
}> {
  const files: Array<{
    path: string;
    sha: string;
    size: number;
    content: string;
    truncated: boolean;
  }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0;

  for (const filePath of input.paths) {
    if (totalBytes >= input.maxTotalBytes) {
      skipped.push({ path: filePath, reason: "Total read limit reached" });
      continue;
    }

    try {
      const response = await githubJson<GithubContentResponse>(
        `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodeGithubPath(filePath)}?ref=${encodeURIComponent(input.branch)}`,
        input.token,
      );
      const body = response.body;
      if (body.type !== "file") {
        skipped.push({ path: filePath, reason: "Path is not a file" });
        continue;
      }
      if (body.size > input.maxFileBytes) {
        skipped.push({ path: filePath, reason: "File exceeds per-file read limit" });
        continue;
      }
      if (totalBytes + body.size > input.maxTotalBytes) {
        skipped.push({ path: filePath, reason: "File exceeds total read limit" });
        continue;
      }
      if (body.encoding !== "base64" || !body.content) {
        skipped.push({ path: filePath, reason: "Unsupported GitHub content encoding" });
        continue;
      }
      const decoded = Buffer.from(body.content.replace(/\s/g, ""), "base64");
      if (!isProbablyText(decoded)) {
        skipped.push({ path: filePath, reason: "Binary files are not readable by ORAX yet" });
        continue;
      }
      const content = decoded.toString("utf8");
      totalBytes += body.size;
      files.push({
        path: body.path || filePath,
        sha: body.sha,
        size: body.size,
        content,
        truncated: false,
      });
    } catch (err) {
      skipped.push({
        path: filePath,
        reason: err instanceof Error ? err.message : "Could not read file",
      });
    }
  }

  return { files, skipped, totalBytes };
}

export async function downloadGithubRepositoryTarball(input: {
  owner: string;
  repo: string;
  branch: string;
  token?: string;
}): Promise<Buffer> {
  const response = await githubFetch(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/tarball/${encodeURIComponent(input.branch)}`,
    input.token,
    { accept: "application/vnd.github+json" },
  );
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_ORAX_TARBALL_BYTES) {
    throw new Error("Repository archive exceeds the ORAX workspace size limit");
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ORAX_TARBALL_BYTES) {
    throw new Error("Repository archive exceeds the ORAX workspace size limit");
  }
  return archive;
}

export async function createGithubPullRequestFromFiles(input: {
  owner: string;
  repo: string;
  token: string;
  baseBranch: string;
  branchName: string;
  title: string;
  body: string;
  commitMessage: string;
  files: Array<{ path: string; content: string }>;
}): Promise<{
  branchName: string;
  baseBranch: string;
  commitSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestState: string;
  changedFiles: string[];
}> {
  if (!input.token.trim()) {
    throw new Error("GitHub token is required for PR creation");
  }
  const branchName = normalizeBranchName(input.branchName);
  if (!branchName || branchName === input.baseBranch || branchName.includes("..")) {
    throw new Error("Invalid ORAX branch name");
  }
  if (!input.files.length) {
    throw new Error("No files provided for PR creation");
  }

  const baseRef = await githubJson<GithubRefResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/ref/heads/${encodeRefPath(input.baseBranch)}`,
    input.token,
  );
  const baseCommitSha = baseRef.body.object.sha;
  const baseCommit = await githubJson<GithubCommitResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/commits/${encodeURIComponent(baseCommitSha)}`,
    input.token,
  );

  const treeEntries = [];
  for (const file of input.files) {
    const blob = await githubJson<GithubBlobResponse>(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/blobs`,
      input.token,
      {
        method: "POST",
        body: {
          content: file.content,
          encoding: "utf-8",
        },
      },
    );
    treeEntries.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.body.sha,
    });
  }

  const tree = await githubJson<GithubCreateTreeResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/trees`,
    input.token,
    {
      method: "POST",
      body: {
        base_tree: baseCommit.body.tree.sha,
        tree: treeEntries,
      },
    },
  );

  const commit = await githubJson<GithubCommitResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/commits`,
    input.token,
    {
      method: "POST",
      body: {
        message: input.commitMessage,
        tree: tree.body.sha,
        parents: [baseCommitSha],
      },
    },
  );

  await githubJson<{ ref: string }>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/refs`,
    input.token,
    {
      method: "POST",
      body: {
        ref: `refs/heads/${branchName}`,
        sha: commit.body.sha,
      },
    },
  );

  const pull = await githubJson<GithubPullResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`,
    input.token,
    {
      method: "POST",
      body: {
        title: input.title,
        head: branchName,
        base: input.baseBranch,
        body: input.body,
        maintainer_can_modify: true,
      },
    },
  );

  return {
    branchName,
    baseBranch: input.baseBranch,
    commitSha: commit.body.sha,
    pullRequestNumber: pull.body.number,
    pullRequestUrl: pull.body.html_url,
    pullRequestState: pull.body.state,
    changedFiles: input.files.map((file) => file.path),
  };
}

export function summarizeGithubTree(input: {
  owner: string;
  name: string;
  repo: GithubRepoResponse;
  branch: string;
  commitSha: string;
  tree: GithubTreeResponse;
}): OraxGithubScanSummary {
  const files = input.tree.tree.filter((entry) => entry.type === "blob");
  const directories = input.tree.tree.filter((entry) => entry.type === "tree");
  const totalBytes = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const languages = files.reduce<Record<string, number>>((acc, entry) => {
    const language = extensionToLanguage(entry.path);
    if (!language) return acc;
    acc[language] = (acc[language] ?? 0) + 1;
    return acc;
  }, {});
  const topLevelEntries = input.tree.tree
    .filter((entry) => !entry.path.includes("/"))
    .slice(0, 50)
    .map((entry) => ({ path: entry.path, type: entry.type }));
  const sampleFiles = files
    .map((entry) => entry.path)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 80);

  return {
    repo: {
      owner: input.owner,
      name: input.name,
      fullName: input.repo.full_name,
      defaultBranch: input.repo.default_branch,
      htmlUrl: input.repo.html_url,
      private: input.repo.private,
      language: input.repo.language,
      size: input.repo.size,
      pushedAt: input.repo.pushed_at,
    },
    branch: input.branch,
    commitSha: input.commitSha,
    fileCount: files.length,
    directoryCount: directories.length,
    totalBytes,
    languages,
    topLevelEntries,
    sampleFiles,
    truncated: Boolean(input.tree.truncated),
  };
}

export function extensionToLanguage(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const map: Record<string, string> = {
    c: "C",
    cc: "C++",
    cpp: "C++",
    cs: "C#",
    css: "CSS",
    go: "Go",
    html: "HTML",
    java: "Java",
    js: "JavaScript",
    jsx: "JavaScript",
    json: "JSON",
    kt: "Kotlin",
    md: "Markdown",
    php: "PHP",
    py: "Python",
    rb: "Ruby",
    rs: "Rust",
    sh: "Shell",
    sql: "SQL",
    swift: "Swift",
    ts: "TypeScript",
    tsx: "TypeScript",
    vue: "Vue",
    yaml: "YAML",
    yml: "YAML",
  };
  return map[ext] ?? null;
}

async function githubJson<T>(
  path: string,
  token?: string,
  options?: {
    method?: "GET" | "POST";
    body?: unknown;
  },
): Promise<{ body: T; scopes: string | null }> {
  const response = await githubFetch(path, token, {
    method: options?.method ?? "GET",
    body: options?.body,
    accept: "application/vnd.github+json",
  });
  const text = await response.text();
  const body = text ? safeJson(text) : null;

  if (!response.ok) {
    const message =
      typeof body === "object" && body && "message" in body
        ? String((body as { message?: unknown }).message)
        : `GitHub returned HTTP ${response.status}`;
    throw new Error(message);
  }

  return {
    body: body as T,
    scopes: response.headers.get("x-oauth-scopes"),
  };
}

async function githubFetch(
  path: string,
  token?: string,
  options?: {
    method?: "GET" | "POST";
    body?: unknown;
    accept?: string;
  },
): Promise<Response> {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    method: options?.method ?? "GET",
    headers: {
      Accept: options?.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const body = text ? safeJson(text) : null;
    const message =
      typeof body === "object" && body && "message" in body
        ? String((body as { message?: unknown }).message)
        : `GitHub returned HTTP ${response.status}`;
    throw new Error(message);
  }

  return response;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function encodeGithubPath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function encodeRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function normalizeBranchName(branchName: string): string {
  return branchName
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .slice(0, 120);
}

function isProbablyText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return !sample.includes(0);
}

function normalizeScopes(scopes: string | null): string {
  return (
    scopes
      ?.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean)
      .join(", ") ?? ""
  );
}
