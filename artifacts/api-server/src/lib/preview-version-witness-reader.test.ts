import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  descriptor: vi.fn(),
  supported: vi.fn(),
  resolveCandidate: vi.fn(),
}));
vi.mock("@workspace/db", async (original) => ({
  ...(await original<typeof import("@workspace/db")>()),
  db: { transaction: mocks.transaction },
}));
vi.mock("./tenant-runtime", () => ({
  tenantRuntimeProvider: { zeroGenerationRuntimeDescriptor: mocks.descriptor },
}));
vi.mock("./tenant-runtime-provider", () => ({ supportsZeroGeneration: mocks.supported }));
vi.mock("./sealed-testing-candidate", async (original) => ({
  ...(await original<typeof import("./sealed-testing-candidate")>()),
  resolveSealedTestingCandidate: mocks.resolveCandidate,
}));
import { readPreviewVersionWitness } from "./preview-version-provenance";

const project = { id: 81, runtimeId: "runtime-81", runtimeStatus: "running" };
const files = [{ path: "index.html", content: "<h1>Preview</h1>", mimeType: "text/html" }];
const version = { id: 100, filesSnapshot: files, sealedRelease: { accepted: "fixture" } };
const runtime = {
  identity: "runtime-81",
  manifestRevision: "manifest-v1",
  status: "running",
  endpoint: null,
};

function databaseRows(groups: unknown[][]) {
  const select = vi.fn(() => {
    const rows = groups.shift() ?? [];
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
    };
    return query;
  });
  mocks.transaction.mockImplementation(async (work) => work({ select }));
  return select;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.supported.mockReturnValue(true);
  databaseRows([[project], [version], files]);
  mocks.descriptor.mockResolvedValue(runtime);
  mocks.resolveCandidate.mockReturnValue({
    versionId: 100,
    release: { sealedArtifactSha256: "b".repeat(64) },
  });
});

describe("preview witness reader composition", () => {
  it("passes the exact snapshot and metadata into accepted-release validation", async () => {
    const result = await readPreviewVersionWitness({ id: 81, ownerId: "owner" });
    expect(result).toEqual({
      projectId: 81,
      versionId: 100,
      runtimeIdentity: "runtime-81",
      manifestRevision: "manifest-v1",
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sealedArtifactSha256: "b".repeat(64),
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(mocks.descriptor).toHaveBeenCalledWith("runtime-81", 81);
    expect(mocks.resolveCandidate).toHaveBeenCalledWith({
      versionId: 100,
      versionSnapshot: files,
      currentFiles: files,
      sealedRelease: version.sealedRelease,
      runtime,
    });
  });

  it.each([
    ["missing project", [[]]],
    ["stopped runtime", [[{ ...project, runtimeStatus: "stopped" }]]],
    ["missing runtime", [[{ ...project, runtimeId: null }]]],
    ["missing version", [[project], []]],
  ])("does not inspect or wake a %s", async (_label, groups) => {
    databaseRows(groups as unknown[][]);
    expect(await readPreviewVersionWitness({ id: 81, ownerId: "owner" })).toBeNull();
    expect(mocks.descriptor).not.toHaveBeenCalled();
    expect(mocks.resolveCandidate).not.toHaveBeenCalled();
  });

  it("returns no witness when the provider lacks sealed-generation inspection", async () => {
    mocks.supported.mockReturnValue(false);
    expect(await readPreviewVersionWitness({ id: 81, ownerId: "owner" })).toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.descriptor).not.toHaveBeenCalled();
  });

  it.each(["database", "provider", "accepted-release validation"])(
    "fails closed on %s failure",
    async (stage) => {
      if (stage === "database") mocks.transaction.mockRejectedValue(new Error("fixture error"));
      if (stage === "provider") mocks.descriptor.mockRejectedValue(new Error("fixture error"));
      if (stage === "accepted-release validation")
        mocks.resolveCandidate.mockImplementation(() => {
          throw new Error("mismatch");
        });
      expect(await readPreviewVersionWitness({ id: 81, ownerId: "owner" })).toBeNull();
    },
  );
});
