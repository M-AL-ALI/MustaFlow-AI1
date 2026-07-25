/**
 * Ora GitHub connection — OAuth flow + token storage + REST helpers.
 *
 * Ora-owned and deliberately separate from the Builder's project-scoped
 * GitHub OAuth (lib/githubOAuth.ts) and from all Orax machinery. Only the
 * OAuth *app credentials* (GITHUB_OAUTH_CLIENT_ID/SECRET env) are shared —
 * no code is imported from either.
 *
 * HARD BOUNDARY: Ora is READ-ONLY on GitHub. This module exposes token
 * storage and read-only REST calls (user, repo list, repo meta, commits,
 * diffs, tarball). There is intentionally no function here — or anywhere in
 * Ora's namespace — that writes, commits, pushes, or mutates a repository.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, oraGithubConnectionsTable } from "@workspace/db";
import { encryptionService } from "../encryption";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";
// `repo` is required for private-repo read access (GitHub OAuth apps have no
// read-only repo scope); read-only is enforced at Ora's tool layer instead.
const ORA_SCOPES = "repo read:user";
const STATE_TTL_MS = 10 * 60 * 1000;

export type OraGithubPlatform = "web" | "mobile";

function getStateSecret(): string {
  const secret = process.env.ENCRYPTION_KEY ?? "";
  if (!secret) throw new Error("ENCRYPTION_KEY is required to sign Ora GitHub OAuth state");
  return secret;
}

export function isOraGithubConfigured(): boolean {
  return Boolean(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

interface OraStatePayload {
  uid: string;
  platform: OraGithubPlatform;
  nonce: string;
  ts: number;
}

export function signOraOAuthState(userId: string, platform: OraGithubPlatform): string {
  const payload: OraStatePayload = {
    uid: userId,
    platform,
    nonce: randomBytes(12).toString("hex"),
    ts: Date.now(),
  };
  const encoded = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", getStateSecret()).update(`ora-github:${encoded}`).digest();
  return `${encoded}.${b64url(sig)}`;
}

export function verifyOraOAuthState(
  state: string,
): { ok: true; payload: OraStatePayload } | { ok: false; reason: string } {
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed state" };
  const [encoded, sig] = parts as [string, string];
  const expected = createHmac("sha256", getStateSecret()).update(`ora-github:${encoded}`).digest();
  let actual: Buffer;
  try {
    actual = b64urlDecode(sig);
  } catch {
    return { ok: false, reason: "bad signature encoding" };
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "bad signature" };
  }
  let payload: OraStatePayload;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString("utf8")) as OraStatePayload;
  } catch {
    return { ok: false, reason: "bad payload" };
  }
  if (!payload.uid || typeof payload.uid !== "string") return { ok: false, reason: "missing uid" };
  if (Date.now() - payload.ts > STATE_TTL_MS) return { ok: false, reason: "state expired" };
  return { ok: true, payload };
}

export function oraGithubRedirectUri(req: {
  protocol: string;
  get(h: string): string | undefined;
}): string {
  const override = process.env.ORA_GITHUB_OAUTH_REDIRECT_URL?.trim();
  if (override) return override;
  const host = req.get("host") ?? "localhost";
  return `${req.protocol}://${host}/api/ora/github/oauth/callback`;
}

export function buildOraAuthorizeUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_OAUTH_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    scope: ORA_SCOPES,
    state,
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeOraOAuthCode(
  code: string,
  redirectUri: string,
): Promise<{ ok: true; token: string; scopes: string } | { ok: false; reason: string }> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) return { ok: false, reason: `token exchange HTTP ${res.status}` };
  const data = (await res.json()) as { access_token?: string; scope?: string; error?: string };
  if (!data.access_token) return { ok: false, reason: data.error ?? "no access_token in response" };
  return { ok: true, token: data.access_token, scopes: data.scope ?? "" };
}

// ── Connection storage (token encrypted at rest, never returned to clients) ──

export async function saveOraGithubConnection(
  userId: string,
  token: string,
  githubLogin: string,
  scopes: string,
): Promise<void> {
  const encryptedToken = encryptionService.encrypt(token);
  const existing = await db
    .select({ id: oraGithubConnectionsTable.id })
    .from(oraGithubConnectionsTable)
    .where(eq(oraGithubConnectionsTable.userId, userId))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(oraGithubConnectionsTable)
      .set({ encryptedToken, githubLogin, scopes, updatedAt: new Date() })
      .where(eq(oraGithubConnectionsTable.userId, userId));
  } else {
    await db
      .insert(oraGithubConnectionsTable)
      .values({ userId, encryptedToken, githubLogin, scopes });
  }
}

export async function getOraGithubConnection(
  userId: string,
): Promise<{ login: string; scopes: string } | null> {
  const rows = await db
    .select({
      githubLogin: oraGithubConnectionsTable.githubLogin,
      scopes: oraGithubConnectionsTable.scopes,
    })
    .from(oraGithubConnectionsTable)
    .where(eq(oraGithubConnectionsTable.userId, userId))
    .limit(1);
  const row = rows[0];
  return row ? { login: row.githubLogin, scopes: row.scopes } : null;
}

export async function getOraGithubToken(userId: string): Promise<string | null> {
  const rows = await db
    .select({ encryptedToken: oraGithubConnectionsTable.encryptedToken })
    .from(oraGithubConnectionsTable)
    .where(eq(oraGithubConnectionsTable.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    return encryptionService.decrypt(row.encryptedToken);
  } catch {
    return null;
  }
}

export async function deleteOraGithubConnection(userId: string): Promise<void> {
  await db.delete(oraGithubConnectionsTable).where(eq(oraGithubConnectionsTable.userId, userId));
}

// ── Read-only GitHub REST helpers ────────────────────────────────────────────

export class OraGithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited: boolean,
  ) {
    super(message);
    this.name = "OraGithubApiError";
  }
}

function githubApiFailure(path: string, res: Response): OraGithubApiError {
  const rateLimited =
    res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
  const detail = rateLimited
    ? "GitHub API rate limit reached; retry shortly"
    : `GitHub API request failed with HTTP ${res.status}`;
  return new OraGithubApiError(`${detail} (${path})`, res.status, rateLimited);
}

async function githubGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ora-repo-analyst",
    },
  });
  if (!res.ok) {
    throw githubApiFailure(path, res);
  }
  return (await res.json()) as T;
}

export async function fetchGithubUser(token: string): Promise<{ login: string }> {
  return githubGet<{ login: string }>(token, "/user");
}

export interface OraGithubRepoSummary {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  pushedAt: string | null;
}

export async function listGithubRepos(token: string): Promise<OraGithubRepoSummary[]> {
  type ApiRepo = {
    full_name: string;
    name: string;
    owner: { login: string };
    private: boolean;
    default_branch: string;
    description: string | null;
    pushed_at: string | null;
  };
  const out: OraGithubRepoSummary[] = [];
  for (let page = 1; page <= 2; page++) {
    const repos = await githubGet<ApiRepo[]>(
      token,
      `/user/repos?per_page=100&sort=pushed&page=${page}`,
    );
    for (const r of repos) {
      out.push({
        fullName: r.full_name,
        owner: r.owner.login,
        name: r.name,
        private: r.private,
        defaultBranch: r.default_branch,
        description: r.description,
        pushedAt: r.pushed_at,
      });
    }
    if (repos.length < 100) break;
  }
  return out;
}

export async function fetchRepoMeta(
  token: string,
  owner: string,
  repo: string,
): Promise<{ defaultBranch: string; private: boolean; sizeKb: number }> {
  const meta = await githubGet<{ default_branch: string; private: boolean; size: number }>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
  return { defaultBranch: meta.default_branch, private: meta.private, sizeKb: meta.size };
}

export interface OraRepoTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface OraRepoTree {
  sha: string;
  truncated: boolean;
  entries: OraRepoTreeEntry[];
}

/**
 * Fetches repository metadata only. The recursive tree contains paths, blob
 * SHAs, and sizes; it never downloads file bodies or a repository archive.
 */
export async function fetchRepoTree(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<OraRepoTree> {
  type ApiTree = {
    sha: string;
    truncated?: boolean;
    tree?: Array<{
      path?: string;
      type?: "blob" | "tree" | "commit";
      sha?: string;
      size?: number;
    }>;
  };
  const treeRef = ref.trim() || "HEAD";
  const apiPath =
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/git/trees/${encodeURIComponent(treeRef)}?recursive=1`;
  const tree = await githubGet<ApiTree>(token, apiPath);
  return {
    sha: tree.sha,
    truncated: Boolean(tree.truncated),
    entries: (tree.tree ?? []).flatMap((entry) =>
      entry.path && entry.type && entry.sha
        ? [
            {
              path: entry.path,
              type: entry.type,
              sha: entry.sha,
              size: entry.size,
            },
          ]
        : [],
    ),
  };
}

export async function fetchRepoBlob(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<Buffer> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) throw new Error("invalid blob sha");
  const apiPath =
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/git/blobs/${encodeURIComponent(sha)}`;
  const blob = await githubGet<{ encoding?: string; content?: string }>(token, apiPath);
  if (blob.encoding !== "base64" || typeof blob.content !== "string") {
    throw new Error("GitHub returned an unsupported blob encoding");
  }
  return Buffer.from(blob.content.replace(/\s+/g, ""), "base64");
}

export async function searchRepoCodePaths(
  token: string,
  owner: string,
  repo: string,
  query: string,
  limit: number,
): Promise<string[]> {
  const capped = Math.max(1, Math.min(limit, 100));
  const params = new URLSearchParams({
    q: `${query} repo:${owner}/${repo}`,
    per_page: String(capped),
  });
  const apiPath = `/search/code?${params.toString()}`;
  const result = await githubGet<{ items?: Array<{ path?: string }> }>(token, apiPath);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const item of result.items ?? []) {
    if (!item.path || seen.has(item.path)) continue;
    seen.add(item.path);
    paths.push(item.path);
    if (paths.length >= capped) break;
  }
  return paths;
}

export interface OraRepoCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export async function fetchRepoCommits(
  token: string,
  owner: string,
  repo: string,
  limit: number,
): Promise<OraRepoCommit[]> {
  type ApiCommit = {
    sha: string;
    commit: { message: string; author: { name?: string; date?: string } | null };
  };
  const capped = Math.max(1, Math.min(limit, 30));
  const commits = await githubGet<ApiCommit[]>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=${capped}`,
  );
  return commits.map((c) => ({
    sha: c.sha.slice(0, 10),
    message: c.commit.message.split("\n")[0] ?? "",
    author: c.commit.author?.name ?? "unknown",
    date: c.commit.author?.date ?? "",
  }));
}

const DIFF_CHAR_CAP = 40_000;

export async function fetchCommitDiff(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<string> {
  if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) throw new Error("invalid commit sha");
  const res = await fetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.diff",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ora-repo-analyst",
      },
    },
  );
  if (!res.ok) throw githubApiFailure(`/repos/${owner}/${repo}/commits/${sha}`, res);
  const text = await res.text();
  return text.length > DIFF_CHAR_CAP
    ? `${text.slice(0, DIFF_CHAR_CAP)}\n… [diff truncated at ${DIFF_CHAR_CAP} chars]`
    : text;
}

export function tarballUrl(owner: string, repo: string, ref: string): string {
  const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball`;
  return ref ? `${base}/${encodeURIComponent(ref)}` : base;
}
