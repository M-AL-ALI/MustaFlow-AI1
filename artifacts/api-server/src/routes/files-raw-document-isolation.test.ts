import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FixtureRow = Record<string, unknown>;
type Predicate = (row: FixtureRow) => boolean;
type FixtureTable = { name: string; [column: string]: string };

const state = vi.hoisted(() => ({
  tables: {} as Record<string, FixtureRow[]>,
  sessions: {} as Record<string, string>,
  fileSelections: 0,
  getAuth: vi.fn(),
  assetQuery: vi.fn(),
  readAssetBuffer: vi.fn(),
}));

// Evaluate the route's actual project AND file predicates against separate
// tenants. A queued "next row" mock would miss a dropped ownership predicate.
vi.mock("drizzle-orm", () => ({
  eq:
    (column: string, value: unknown): Predicate =>
    (row) =>
      row[column] === value,
  and:
    (...conditions: Predicate[]): Predicate =>
    (row) =>
      conditions.every((condition) => condition(row)),
  or:
    (...conditions: Predicate[]): Predicate =>
    (row) =>
      conditions.some((condition) => condition(row)),
  isNull:
    (column: string): Predicate =>
    (row) =>
      row[column] == null,
  inArray:
    (column: string, values: unknown[]): Predicate =>
    (row) =>
      values.includes(row[column]),
  gt: vi.fn(),
  asc: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  const table = (name: string, columns: string[]): FixtureTable =>
    Object.assign(
      { name },
      Object.fromEntries(columns.map((column) => [column, name + "." + column])),
    );
  const qualifiedRows = (source: FixtureTable): FixtureRow[] =>
    (state.tables[source.name] ?? []).map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [source.name + "." + key, value]),
      ),
    );

  return {
    projectsTable: table("projects", ["id", "ownerId", "organizationId", "deletedAt"]),
    projectFilesTable: table("files", ["id", "projectId", "path", "content", "mimeType"]),
    projectCollaboratorsTable: table("collaborators", ["projectId", "userId", "role"]),
    orgMembersTable: table("members", ["organizationId", "userId", "role"]),
    organizationsTable: table("organizations", ["id", "deletedAt"]),
    projectVersionsTable: table("versions", ["id"]),
    oraxDesktopSessionsTable: table("desktopSessions", []),
    pool: { query: state.assetQuery },
    db: {
      select: (fields?: Record<string, string>) => ({
        from: (source: FixtureTable) => {
          if (source.name === "files") state.fileSelections += 1;
          let rows = qualifiedRows(source);
          const query = {
            innerJoin: (joined: FixtureTable, _condition: Predicate) => {
              // The real access middleware joins membership to its organization.
              // Bind both identities here; deleted-org filtering remains in where.
              if (source.name !== "members" || joined.name !== "organizations") {
                throw new Error("Unexpected raw-boundary fixture join");
              }
              rows = rows.flatMap((row) =>
                qualifiedRows(joined)
                  .filter((other) => row["members.organizationId"] === other["organizations.id"])
                  .map((other) => ({ ...row, ...other })),
              );
              return query;
            },
            where: async (condition: Predicate) =>
              rows.filter(condition).map((row) =>
                Object.fromEntries(
                  fields
                    ? Object.entries(fields).map(([key, column]) => [key, row[column]])
                    : Object.entries(row)
                        .filter(([key]) => key.startsWith(source.name + "."))
                        .map(([key, value]) => [key.slice(source.name.length + 1), value]),
                ),
              ),
          };
          return query;
        },
      }),
    },
  };
});

// Only the credential adapter and external dependencies are replaced. The real
// attachUser, requireProjectAccess, files router, MIME decoder and document
// policy execute for every request.
vi.mock("@clerk/express", () => ({ getAuth: state.getAuth }));
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../lib/asset-r2", () => ({ readAssetBuffer: state.readAssetBuffer }));
vi.mock("../lib/builder", () => ({ guessMime: vi.fn() }));
vi.mock("../lib/page-map", () => ({ extractPageMap: vi.fn() }));
vi.mock("../lib/tenant-runtime", () => ({
  syncFilesToContainer: vi.fn(),
  writeFileToContainer: vi.fn(),
}));
vi.mock("../lib/checks/eslint-runner", () => ({ runEslintFix: vi.fn() }));
vi.mock("../lib/eslint-fix-all", () => ({ applyProjectEslintFixes: vi.fn() }));
vi.mock("../lib/agent-senses", () => ({ readDiagnostics: vi.fn() }));
vi.mock("../lib/livePreviewProxy", () => ({
  handleLivePreviewHttp: vi.fn(),
  loadPreviewProject: vi.fn(),
  shouldRouteToLivePreview: vi.fn(),
  userCanPreviewProject: vi.fn(),
}));
vi.mock("../lib/project-files-preview", () => ({ serveProjectFilesPreview: vi.fn() }));
vi.mock("../lib/project-file-writer", () => ({ writeProjectFilesAtomically: vi.fn() }));
vi.mock("../lib/project-file-asset-usage", () => ({
  reconcileProjectFileAssetUsage: vi.fn(),
}));

import { attachUser } from "../lib/auth";
import { encodeProjectFileAssetReference } from "../lib/project-file-asset-reference";
import filesRouter from "./files";

const OWNER = "Bearer raw-owner";
const HTML = '<!doctype html><script>document.cookie="raw_html_secret=1"</script>';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>window.raw_svg_secret=1</script></svg>';
const FOREIGN_HTML = "<!doctype html><script>window.other_tenant_secret=1</script>";
const RETIRED_HTML = "<!doctype html><script>window.retired_tenant_secret=1</script>";
const RAW_PATH = "/api/projects/71/files/711/raw";

function appFor(existingCsp?: string) {
  const app = express();
  // Synthetic tenant-controlled redirect. The destination is the actual API
  // router; this deliberately does not claim to exercise a provider or gateway.
  app.get("/tenant/redirect/:fileId", (req, res) => {
    res.redirect(302, "/api/projects/71/files/" + req.params.fileId + "/raw");
  });
  if (existingCsp) {
    app.use((_req, res, next) => {
      res.setHeader("Content-Security-Policy", existingCsp);
      next();
    });
  }
  app.use("/api", attachUser, filesRouter);
  return app;
}

function getBytes(app: express.Express, path: string, credential?: string) {
  const pending = request(app)
    .get(path)
    .buffer(true)
    .parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => done(null, Buffer.concat(chunks)));
      response.on("error", done);
    });
  if (credential) pending.set("Authorization", credential);
  return pending;
}

function expectProtected(response: request.Response) {
  const csp = response.headers["content-security-policy"];
  expect(typeof csp).toBe("string");
  const sandboxDirectives = String(csp)
    .split(/[;,]/u)
    .map((directive) => directive.trim())
    .filter((directive) => /^sandbox(?:\s|$)/u.test(directive));
  expect(sandboxDirectives).toContain("sandbox allow-scripts allow-forms allow-popups");
  expect(String(csp)).not.toContain("allow-same-origin");
  expect(response.headers["content-security-policy-report-only"]).toBeUndefined();
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["cache-control"]).toBe("no-store");
}

function expectedContentType(mimeType: string): string {
  // Express already appends UTF-8 for these unparameterized response types.
  // Keep exact checks for MIME case and all explicitly supplied parameters.
  return /^(?:text\/html|application\/json)$/iu.test(mimeType)
    ? `${mimeType}; charset=utf-8`
    : mimeType;
}

function expectNoFileBytes(response: request.Response) {
  const body = Buffer.isBuffer(response.body)
    ? response.body.toString("utf8")
    : (response.text ?? JSON.stringify(response.body));
  for (const payload of [HTML, SVG, FOREIGN_HTML, RETIRED_HTML]) {
    expect(body).not.toContain(payload);
  }
  expect(state.assetQuery).not.toHaveBeenCalled();
  expect(state.readAssetBuffer).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("E2E_TEST_ENABLED", "false");
  state.fileSelections = 0;
  state.tables = {
    projects: [
      { id: 71, ownerId: "owner-71", organizationId: 901, deletedAt: null },
      { id: 72, ownerId: "owner-72", organizationId: 902, deletedAt: null },
      { id: 73, ownerId: "owner-71", organizationId: null, deletedAt: new Date(0) },
    ],
    files: [
      { id: 711, projectId: 71, path: "index.html", mimeType: "text/html", content: HTML },
      { id: 712, projectId: 71, path: "icon.svg", mimeType: "image/svg+xml", content: SVG },
      { id: 721, projectId: 72, path: "index.html", mimeType: "text/html", content: FOREIGN_HTML },
      { id: 731, projectId: 73, path: "index.html", mimeType: "text/html", content: RETIRED_HTML },
    ],
    collaborators: [
      { projectId: 71, userId: "project-viewer", role: "viewer" },
      { projectId: 71, userId: "blocked-role", role: "unknown" },
    ],
    organizations: [
      { id: 901, deletedAt: null },
      { id: 902, deletedAt: null },
    ],
    members: [
      { organizationId: 901, userId: "org-viewer", role: "viewer" },
      { organizationId: 902, userId: "foreign-viewer", role: "viewer" },
    ],
  };
  state.sessions = {
    [OWNER]: "owner-71",
    "Bearer raw-other-owner": "owner-72",
    "Bearer raw-project-viewer": "project-viewer",
    "Bearer raw-org-viewer": "org-viewer",
    "Bearer raw-foreign-viewer": "foreign-viewer",
    "Bearer raw-blocked": "blocked-role",
    "Bearer raw-intruder": "intruder",
  };
  state.getAuth.mockImplementation((req: express.Request) => ({
    userId: state.sessions[req.get("authorization") ?? ""] ?? null,
  }));
  state.assetQuery.mockReset().mockImplementation(async () => {
    throw new Error("Unexpected asset lookup in raw-boundary fixture");
  });
  state.readAssetBuffer.mockReset().mockImplementation(async () => {
    throw new Error("Unexpected asset read in raw-boundary fixture");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("raw-file document isolation through the authorized files router", () => {
  it.each([
    ["text/html", HTML],
    ["TEXT/HTML", HTML],
    ["text/html; charset=UTF-8", HTML],
    ["Text/Html; charset=utf-8", HTML],
    ["application/xhtml+xml", HTML],
    ["Application/Xhtml+Xml; charset=UTF-8", HTML],
    ["image/svg+xml", SVG],
    ["IMAGE/SVG+XML", SVG],
    ["image/svg+xml; charset=utf-8", SVG],
    ["Image/Svg+Xml; charset=UTF-8", SVG],
  ])(
    "enforces an opaque-origin sandbox for %s without changing bytes or MIME",
    async (mimeType, content) => {
      Object.assign(state.tables.files![0]!, { path: "opaque.data", mimeType, content });

      const response = await getBytes(appFor(), RAW_PATH, OWNER).expect(200);

      expectProtected(response);
      expect(response.headers["content-type"]).toBe(expectedContentType(mimeType));
      expect(response.body).toEqual(Buffer.from(content, "utf8"));
      expect(state.fileSelections).toBe(1);
    },
  );

  it.each([OWNER, "Bearer raw-project-viewer", "Bearer raw-org-viewer"])(
    "preserves viewer access and the exact file selection for %s",
    async (credential) => {
      const response = await getBytes(
        appFor(),
        "/api/projects/71/files/712/raw",
        credential,
      ).expect(200);

      expectProtected(response);
      expect(response.headers["content-type"]).toBe("image/svg+xml");
      expect(response.body).toEqual(Buffer.from(SVG, "utf8"));
    },
  );

  it.each([
    [undefined, 401],
    ["Bearer invalid-session", 401],
    ["Bearer raw-intruder", 404],
    ["Bearer raw-other-owner", 404],
    ["Bearer raw-foreign-viewer", 404],
    ["Bearer raw-blocked", 403],
  ] as const)(
    "denies %s before selecting or disclosing raw file bytes",
    async (credential, status) => {
      const response = await getBytes(appFor(), RAW_PATH, credential).expect(status);

      expectNoFileBytes(response);
      expect(state.fileSelections).toBe(0);
    },
  );

  it("also rejects a caller without attached identity at the route's own access middleware", async () => {
    const app = express();
    app.use("/api", filesRouter);

    const response = await getBytes(app, RAW_PATH).expect(401);

    expectNoFileBytes(response);
    expect(state.fileSelections).toBe(0);
  });

  it("denies a viewer whose organization has been retired", async () => {
    state.tables.organizations![0]!.deletedAt = new Date(0);

    const response = await getBytes(appFor(), RAW_PATH, "Bearer raw-org-viewer").expect(404);

    expectNoFileBytes(response);
    expect(state.fileSelections).toBe(0);
  });

  it.each([
    ["/api/projects/71/files/721/raw", OWNER],
    ["/api/projects/72/files/711/raw", "Bearer raw-other-owner"],
    ["/api/projects/71/files/999999/raw", OWNER],
  ])(
    "requires the file to belong to the exact authorized project at %s",
    async (path, credential) => {
      const response = await getBytes(appFor(), path, credential).expect(404);

      expectNoFileBytes(response);
      expect(state.fileSelections).toBe(1);
      expect(JSON.parse(response.body.toString("utf8"))).toEqual({ error: "File not found" });
    },
  );

  it.each([
    ["/api/projects/999/files/711/raw", 404],
    ["/api/projects/73/files/731/raw", 404],
    ["/api/projects/71/files/not-a-number/raw", 400],
  ] as const)(
    "keeps missing/retired project and invalid file responses closed at %s",
    async (path, status) => {
      const response = await getBytes(appFor(), path, OWNER).expect(status);

      expectNoFileBytes(response);
      expect(state.fileSelections).toBe(0);
    },
  );

  it.each([
    ["711", HTML, "text/html"],
    ["712", SVG, "image/svg+xml"],
  ])(
    "protects the final raw response after a tenant redirect to file %s",
    async (fileId, content, mimeType) => {
      const response = await getBytes(appFor(), "/tenant/redirect/" + fileId, OWNER)
        .redirects(1)
        .expect(200);

      expect(response.redirects).toHaveLength(1);
      expectProtected(response);
      expect(response.headers["content-type"]).toBe(expectedContentType(mimeType));
      expect(response.body).toEqual(Buffer.from(content, "utf8"));
      expect(state.fileSelections).toBe(1);
    },
  );

  it("does not grant access when an unauthorized caller follows a tenant redirect", async () => {
    const response = await getBytes(appFor(), "/tenant/redirect/711", "Bearer raw-intruder")
      .redirects(1)
      .expect(404);

    expect(response.redirects).toHaveLength(1);
    expectNoFileBytes(response);
    expect(state.fileSelections).toBe(0);
  });

  it.each([
    [
      "text/plain; charset=utf-8",
      Buffer.from("ordinary text\r\ncaf\u00e9\u0000end", "utf8"),
      false,
    ],
    ["application/json", Buffer.from('{"raw":"unchanged"}\n', "utf8"), false],
    ["image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 127, 128, 255]), true],
    ["application/octet-stream", Buffer.from([0, 1, 13, 10, 127, 128, 254, 255]), true],
  ] as const)("preserves ordinary %s bytes and MIME", async (mimeType, bytes, binary) => {
    Object.assign(state.tables.files![0]!, {
      mimeType,
      content: bytes.toString(binary ? "base64" : "utf8"),
    });

    const response = await getBytes(appFor(), RAW_PATH, OWNER).expect(200);

    expectProtected(response);
    expect(response.headers["content-type"]).toBe(expectedContentType(mimeType));
    expect(response.body).toEqual(bytes);
    expect(response.headers["content-length"]).toBe(String(bytes.length));
  });

  it("protects resolved asset document bytes without exposing the stored reference", async () => {
    const bytes = Buffer.from(SVG, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const reference = encodeProjectFileAssetReference({
      assetId: 8101,
      sizeBytes: bytes.length,
      sha256,
    });
    Object.assign(state.tables.files![0]!, { mimeType: "image/svg+xml", content: reference });
    state.assetQuery.mockResolvedValueOnce({
      rows: [{ storage_key: "fixture/private-raw.svg", size_bytes: String(bytes.length), sha256 }],
    });
    state.readAssetBuffer.mockResolvedValueOnce(bytes);

    const response = await getBytes(appFor(), RAW_PATH, OWNER).expect(200);

    expectProtected(response);
    expect(response.headers["content-type"]).toBe("image/svg+xml");
    expect(response.body).toEqual(bytes);
    expect(response.body.toString("utf8")).not.toContain(reference);
    expect(state.assetQuery).toHaveBeenCalledWith(expect.any(String), [
      8101,
      71,
      "explicit-project-use:v1",
    ]);
    expect(state.readAssetBuffer).toHaveBeenCalledWith("fixture/private-raw.svg", bytes.length);
  });

  it("does not resolve an asset reference for a denied caller", async () => {
    state.tables.files![0]!.content = encodeProjectFileAssetReference({
      assetId: 8101,
      sizeBytes: 1,
      sha256: "a".repeat(64),
    });

    const response = await getBytes(appFor(), RAW_PATH, "Bearer raw-intruder").expect(404);

    expectNoFileBytes(response);
    expect(state.fileSelections).toBe(0);
  });

  it("adds the sandbox alongside an existing enforced response policy", async () => {
    const existing = "default-src 'self'; img-src data:";
    const response = await getBytes(appFor(existing), RAW_PATH, OWNER).expect(200);

    expectProtected(response);
    expect(response.headers["content-security-policy"]).toContain(existing);
    expect(response.body).toEqual(Buffer.from(HTML, "utf8"));
  });
});
