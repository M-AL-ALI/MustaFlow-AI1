import { afterEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 9).toString("base64");
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";

const workspace = await import("../repo-workspace");
const readTools = await import("../repo-read-tools");

let nextSessionId = 70_000;
const usedSessions: number[] = [];

function sessionId(): number {
  const id = nextSessionId++;
  usedSessions.push(id);
  return id;
}

function treeResponse(
  entries: Array<{ path: string; sha: string; size: number; type?: "blob" | "tree" }>,
  truncated = false,
): Response {
  return Response.json({
    sha: "tree-root",
    truncated,
    tree: entries.map((entry) => ({ type: "blob", ...entry })),
  });
}

function blobResponse(text: string): Response {
  return Response.json({
    encoding: "base64",
    content: Buffer.from(text, "utf8").toString("base64"),
  });
}

function materialize(id: number) {
  return workspace.materializeRepoWorkspace({
    sessionId: id,
    owner: "M-AL-ALI",
    repo: "MustaFlow-AI1",
    ref: "",
    defaultBranch: "main",
    token: "test-token",
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(usedSessions.splice(0).map((id) => workspace.destroyRepoWorkspace(id)));
});

describe("lazy GitHub API repository workspace", () => {
  it("reads a repo whose excluded media exceeds the old tarball cap without downloading an archive", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/git/trees/")) {
          return treeResponse([
            {
              path: "attached_assets/demo-recording.mp4",
              sha: "aaaa",
              size: 130 * 1024 * 1024,
            },
            { path: "artifacts/mustaflow/src/app.tsx", sha: "bbbb", size: 2048 },
          ]);
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    const ws = await materialize(sessionId());

    expect(ws.source).toBe("github_api");
    expect(ws.files.map((file) => file.path)).toEqual(["artifacts/mustaflow/src/app.tsx"]);
    expect(ws.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "attached_assets/demo-recording.mp4",
          reason: "skipped_directory",
        }),
      ]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/git/trees/main?recursive=1");
    expect(calls[0]).not.toContain("/tarball");
  });

  it("filters skipped directories, binaries, and oversized blobs from tree metadata", () => {
    const filtered = workspace.filterRepoTreeEntries([
      { path: "src/index.ts", type: "blob", sha: "aaaa", size: 500 },
      { path: "node_modules/pkg/index.js", type: "blob", sha: "bbbb", size: 300 },
      { path: "public/logo.png", type: "blob", sha: "cccc", size: 800 },
      {
        path: "src/generated.txt",
        type: "blob",
        sha: "dddd",
        size: workspace.REPO_WORKSPACE_LIMITS.maxFileBytes + 1,
      },
    ]);

    expect(filtered.files.map((file) => file.path)).toEqual(["src/index.ts"]);
    expect(filtered.skipped.map((entry) => entry.reason).sort()).toEqual(
      ["binary", "oversized_file", "skipped_directory"].sort(),
    );
  });

  it("read_file fetches exactly one blob and reuses the per-session cache", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/git/trees/")) {
          return treeResponse([{ path: "src/index.ts", sha: "a1b2c3d4", size: 35 }]);
        }
        if (url.includes("/git/blobs/a1b2c3d4")) {
          return blobResponse("const answer = 42;\nexport { answer };\n");
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    const ws = await materialize(sessionId());
    const first = await readTools.readFile(ws, "src/index.ts", 1, 1);
    const second = await readTools.readFile(ws, "src/index.ts", 2, 2);

    expect(first.content).toContain("1\tconst answer = 42;");
    expect(second.content).toContain("2\texport { answer };");
    expect(calls.filter((url) => url.includes("/git/blobs/"))).toHaveLength(1);
    expect(calls.some((url) => url.includes("/tarball"))).toBe(false);
  });

  it("uses scoped code search and caps file-line-snippet matches at 60", async () => {
    const matchingBody = Array.from(
      { length: 70 },
      (_, index) => `export const needle${index} = "needle";`,
    ).join("\n");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/git/trees/")) {
          return treeResponse([{ path: "src/matches.ts", sha: "abcd1234", size: 3500 }]);
        }
        if (url.includes("/search/code?")) {
          return Response.json({ items: [{ path: "src/matches.ts" }] });
        }
        if (url.includes("/git/blobs/abcd1234")) return blobResponse(matchingBody);
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    const ws = await materialize(sessionId());
    const result = await readTools.searchRepo(ws, "needle");

    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/matches.ts:1:");
    expect(result.content).toContain("60 match(es)");
    expect(result.content).toContain("results capped at 60");
    expect(calls.find((url) => url.includes("/search/code?"))).toContain(
      "repo%3AM-AL-ALI%2FMustaFlow-AI1",
    );
    expect(calls.filter((url) => url.includes("/git/blobs/"))).toHaveLength(1);
  });

  it("falls back to a bounded targeted scan when code search is rate-limited", async () => {
    const calls: string[] = [];
    const distractors = Array.from({ length: 90 }, (_, index) => ({
      path: `src/unrelated-${index}.ts`,
      sha: `b${String(index).padStart(7, "0")}`,
      size: 80,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/git/trees/")) {
          return treeResponse([
            ...distractors,
            {
              path: "artifacts/api-server/src/lib/public-ai/route-resolution.ts",
              sha: "1111aaaa",
              size: 80,
            },
          ]);
        }
        if (url.includes("/search/code?")) {
          return new Response("rate limited", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
          });
        }
        if (url.includes("/git/blobs/1111aaaa")) {
          return blobResponse("export function resolveFinalOraRoute() { return true; }\n");
        }
        if (url.includes("/git/blobs/")) {
          return blobResponse("export const unrelated = true;\n");
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    const ws = await materialize(sessionId());
    const result = await readTools.searchRepo(ws, "resolveFinalOraRoute");

    expect(result.ok).toBe(true);
    expect(result.content).toContain(
      "artifacts/api-server/src/lib/public-ai/route-resolution.ts:1:",
    );
    expect(calls.filter((url) => url.includes("/git/blobs/")).length).toBeLessThanOrEqual(
      workspace.REPO_WORKSPACE_LIMITS.maxFallbackSearchFiles,
    );
    expect(calls.find((url) => url.includes("/git/blobs/"))).toContain("1111aaaa");
    expect(calls.some((url) => url.includes("/tarball"))).toBe(false);
  });

  it("states that no code was analyzed when the filtered tree contains only media", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/git/trees/")) {
          return treeResponse([
            {
              path: "attached_assets/screen-recording.mp4",
              sha: "deadbeef",
              size: 47 * 1024 * 1024,
            },
          ]);
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    await expect(materialize(sessionId())).rejects.toThrow(
      /screen-recording\.mp4 \(47 MB, excluded directory entry\).*No repository code was analyzed/i,
    );
  });
});
