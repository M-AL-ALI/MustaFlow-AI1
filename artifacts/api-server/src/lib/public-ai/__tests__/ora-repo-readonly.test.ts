/**
 * Ora GitHub repo analysis — read-only guarantees, sandbox guards, OAuth state.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";
// repo-analyst transitively imports the AI provider client, which asserts
// these at module load. The URL-parse tests never make an AI call.
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL =
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "http://127.0.0.1:9/v1";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY =
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? "test-placeholder";

// Dynamic imports so the env defaults above land before @workspace/db loads
// (static imports would hoist past them). No test in this file touches the DB.
const { signOraOAuthState, verifyOraOAuthState } = await import("../repo-github-auth");
const readTools = await import("../repo-read-tools");
const { REPO_READ_TOOL_NAMES } = readTools;
const { isBinaryPath, resolveWorkspacePath, REPO_WORKSPACE_LIMITS } =
  await import("../repo-workspace");
type RepoWorkspace = import("../repo-workspace").RepoWorkspace;

describe("read-only tool surface", () => {
  it("exposes exactly the five read tools and no write verbs", () => {
    expect([...REPO_READ_TOOL_NAMES].sort()).toEqual(
      ["diff", "list_files", "read_commits", "read_file", "search_repo"].sort(),
    );
    const forbidden = /write|commit_change|push|create_pr|mutate|delete_file|apply_patch/i;
    for (const exportName of Object.keys(readTools)) {
      expect(exportName).not.toMatch(forbidden);
    }
  });

  it("enforces sane workspace limits", () => {
    expect(REPO_WORKSPACE_LIMITS.maxTarballBytes).toBeLessThanOrEqual(100 * 1024 * 1024);
    expect(REPO_WORKSPACE_LIMITS.maxFiles).toBeLessThanOrEqual(20_000);
    expect(REPO_WORKSPACE_LIMITS.ttlMs).toBeGreaterThan(0);
  });
});

describe("path traversal guards", () => {
  const root = path.resolve(os.tmpdir(), "ora-ws-root");
  it("rejects .. traversal and absolute escapes", () => {
    expect(resolveWorkspacePath(root, "../etc/passwd")).toBeNull();
    expect(resolveWorkspacePath(root, "a/../../etc/passwd")).toBeNull();
    expect(resolveWorkspacePath(root, "src/../../../root")).toBeNull();
  });
  it("accepts normal repo-relative paths (leading slash stripped)", () => {
    const expected = path.join(root, "src", "index.ts");
    expect(resolveWorkspacePath(root, "src/index.ts")).toBe(expected);
    expect(resolveWorkspacePath(root, "/src/index.ts")).toBe(expected);
  });
  it("classifies binaries by extension", () => {
    expect(isBinaryPath("logo.png")).toBe(true);
    expect(isBinaryPath("src/app.ts")).toBe(false);
  });
});

describe("pasted GitHub URL parsing (auto-attach)", () => {
  it("extracts owner/repo from pasted URLs in chat messages", async () => {
    const { parseGithubRepoUrl } = await import("../repo-analyst");
    expect(parseGithubRepoUrl("look at https://github.com/M-AL-ALI/MustaFlow-AI1 please")).toEqual({
      owner: "M-AL-ALI",
      repo: "MustaFlow-AI1",
    });
    expect(parseGithubRepoUrl("https://github.com/foo/bar/tree/main/src")).toEqual({
      owner: "foo",
      repo: "bar",
    });
    expect(parseGithubRepoUrl("git clone https://github.com/foo/bar.git")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("ignores non-repo GitHub paths and plain text", async () => {
    const { parseGithubRepoUrl } = await import("../repo-analyst");
    expect(parseGithubRepoUrl("no url here at all")).toBeNull();
    expect(parseGithubRepoUrl("https://github.com/orgs/anthropics")).toBeNull();
    expect(parseGithubRepoUrl("https://github.com/features/copilot")).toBeNull();
  });
});

describe("connected repository context", () => {
  it("never asks for a pasted URL once GitHub is connected", async () => {
    const { CONNECTED_REPO_SELECTION_GUIDANCE, REPO_GUIDANCE_ADDENDUM } =
      await import("../repo-analyst");

    expect(REPO_GUIDANCE_ADDENDUM).toMatch(/already connected and resolved/i);
    expect(REPO_GUIDANCE_ADDENDUM).toMatch(/never ask[\s\S]*paste[\s\S]*URL/i);
    expect(CONNECTED_REPO_SELECTION_GUIDANCE).toMatch(/already connected/i);
    expect(CONNECTED_REPO_SELECTION_GUIDANCE).toMatch(/name or select/i);
    expect(CONNECTED_REPO_SELECTION_GUIDANCE).toMatch(/never ask[\s\S]*paste[\s\S]*URL/i);
  });

  it("resolves a named owned repo without treating substrings as repo mentions", async () => {
    const { findConnectedRepoForRequest, shouldSearchConnectedRepos } =
      await import("../repo-analyst");
    const repos = [
      {
        fullName: "M-AL-ALI/MustaFlow-AI1",
        owner: "M-AL-ALI",
        name: "MustaFlow-AI1",
        private: true,
        defaultBranch: "main",
        description: null,
        pushedAt: null,
      },
      {
        fullName: "M-AL-ALI/app",
        owner: "M-AL-ALI",
        name: "app",
        private: true,
        defaultBranch: "main",
        description: null,
        pushedAt: null,
      },
    ];

    expect(
      findConnectedRepoForRequest(
        repos,
        "Read package.json in MustaFlow-AI1 and tell me what it does.",
      )?.fullName,
    ).toBe("M-AL-ALI/MustaFlow-AI1");
    expect(findConnectedRepoForRequest(repos, "I am happy with this answer.")).toBeNull();
    expect(findConnectedRepoForRequest(repos, "", "M-AL-ALI/app")?.name).toBe("app");

    const current = { owner: "M-AL-ALI", repo: "app" };
    expect(
      shouldSearchConnectedRepos("Analyze the repo MustaFlow-AI1 instead.", undefined, current),
    ).toBe(true);
    expect(shouldSearchConnectedRepos("", "M-AL-ALI/MustaFlow-AI1", current)).toBe(true);
    expect(shouldSearchConnectedRepos("", "M-AL-ALI/app", current)).toBe(false);
    expect(shouldSearchConnectedRepos("I am happy with this answer.", undefined, current)).toBe(
      false,
    );
  });
});

describe("OAuth state HMAC", () => {
  it("round-trips a signed state and rejects tampering", () => {
    const state = signOraOAuthState("user_123", "mobile");
    const ok = verifyOraOAuthState(state);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.payload.uid).toBe("user_123");
      expect(ok.payload.platform).toBe("mobile");
    }
    const tampered = `${state.slice(0, -4)}aaaa`;
    expect(verifyOraOAuthState(tampered).ok).toBe(false);
    expect(verifyOraOAuthState("garbage").ok).toBe(false);
  });
});

describe("pure-JS tarball extraction (no system tar dependency)", () => {
  it("extracts a real tar.gz, strips the root dir, and skips symlinks/binaries/node_modules", async () => {
    const { extractTarGz } = await import("../repo-workspace");
    const { execSync } = await import("node:child_process");
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), "ora-tarfix-"));
    const repoDir = path.join(stage, "owner-repo-abc123");
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "node_modules", "junk"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "README.md"), "hello ora\n");
    await fs.writeFile(path.join(repoDir, "src", "app.ts"), "export const x = 1;\n");
    await fs.writeFile(path.join(repoDir, "logo.png"), Buffer.from([137, 80, 78, 71]));
    await fs.writeFile(path.join(repoDir, "node_modules", "junk", "index.js"), "junk\n");
    let symlinkCreated = true;
    try {
      await fs.symlink("/etc/passwd", path.join(repoDir, "evil-link"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      symlinkCreated = false;
    }
    const longDir = "a-quite-long-directory-name-segment-for-pax/".repeat(3);
    await fs.mkdir(path.join(repoDir, longDir), { recursive: true });
    await fs.writeFile(path.join(repoDir, longDir, "deep.txt"), "deep pax path\n");
    const tarPath = path.join(stage, "fixture.tar.gz");
    execSync(`tar -czf ${JSON.stringify(tarPath)} -C ${JSON.stringify(stage)} owner-repo-abc123`);

    const dest = await fs.mkdtemp(path.join(os.tmpdir(), "ora-tarout-"));
    const gz = await fs.readFile(tarPath);
    await extractTarGz([gz], dest);

    expect(await fs.readFile(path.join(dest, "README.md"), "utf8")).toBe("hello ora\n");
    expect(await fs.readFile(path.join(dest, "src", "app.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(await fs.readFile(path.join(dest, longDir, "deep.txt"), "utf8")).toBe("deep pax path\n");
    if (symlinkCreated) {
      await expect(fs.lstat(path.join(dest, "evil-link"))).rejects.toThrow();
    }
    await expect(fs.stat(path.join(dest, "logo.png"))).rejects.toThrow();
    await expect(fs.stat(path.join(dest, "node_modules"))).rejects.toThrow();
  });

  it("rejects corrupt input instead of hanging", async () => {
    const { extractTarGz } = await import("../repo-workspace");
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), "ora-tarbad-"));
    await expect(extractTarGz([Buffer.from("not gzip at all")], dest)).rejects.toThrow();
  });
});

describe("read tools against a real sandbox workspace", () => {
  let ws: RepoWorkspace;
  beforeAll(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ora-repo-test-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "README.md"), "# Demo\nhello ora\n");
    await fs.writeFile(
      path.join(root, "src", "main.ts"),
      "const value = 1;\nfunction findMe() {\n  return value;\n}\n",
    );
    ws = {
      root,
      files: [
        { path: "README.md", bytes: 20 },
        { path: "src/main.ts", bytes: 60 },
      ],
      totalBytes: 80,
      truncated: false,
      lastUsedAt: Date.now(),
    };
  });

  it("list_files shows dirs and files", () => {
    const res = readTools.listFiles(ws, "");
    expect(res.ok).toBe(true);
    expect(res.content).toContain("src/");
    expect(res.content).toContain("README.md");
  });

  it("read_file returns numbered lines and respects ranges", async () => {
    const res = await readTools.readFile(ws, "src/main.ts", 2, 3);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("2\tfunction findMe()");
    expect(res.content).not.toContain("const value");
  });

  it("read_file refuses files outside the index", async () => {
    const res = await readTools.readFile(ws, "../../etc/passwd");
    expect(res.ok).toBe(false);
  });

  it("search_repo finds matches with file:line locations", async () => {
    const res = await readTools.searchRepo(ws, "findMe");
    expect(res.ok).toBe(true);
    expect(res.content).toContain("src/main.ts:2");
  });
});
