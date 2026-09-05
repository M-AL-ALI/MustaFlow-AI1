import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), readAssetBuffer: vi.fn() }));

vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));
vi.mock("./asset-r2", () => ({ readAssetBuffer: mocks.readAssetBuffer }));
import {
  encodeProjectFileAssetReference,
  MAX_PROJECT_FILE_ASSET_BYTES,
  parseProjectFileAssetReference,
  projectFileByteSize,
  pinProjectFileAssetHistory,
  resolveProjectFileBytes,
  resolveProjectFileClientContent,
  resolveProjectRuntimeFiles,
} from "./project-file-asset-reference";

type AccessUsage = {
  assetId: number;
  projectId: number;
  consumer: string;
  artifactId: number | null;
  versionId: number | null;
  filePath: string | null;
};
type AccessFixture = {
  productScope: "nabuflow" | "ora" | null;
  assetProjectId: number | null;
  targetActive?: boolean;
  state?: string;
  usages: AccessUsage[];
};
const exactTargetGrant: AccessUsage = {
  assetId: 71,
  projectId: 9,
  consumer: "explicit-project-use:v1",
  artifactId: null,
  versionId: null,
  filePath: null,
};
const fixtureBytes = Buffer.from([0, 255, 1, 2, 128]);
const fixtureSha = createHash("sha256").update(fixtureBytes).digest("hex");
const fixtureContent = encodeProjectFileAssetReference({
  assetId: 71,
  sizeBytes: fixtureBytes.length,
  sha256: fixtureSha,
});

/** SQL-contract unit model; real PostgreSQL execution belongs to the parent gate. */
function mockScopedDelivery(fixture: AccessFixture): void {
  mocks.query.mockImplementation(async (statement: string, parameters: unknown[]) => {
    const normalized = statement.replace(/\s+/gu, " ").trim();
    expect(parameters).toEqual([71, 9, "explicit-project-use:v1"]);
    expect(normalized).toContain(
      "WHERE asset.id=$1 AND asset.state='ready' AND asset.product_scope='nabuflow' AND asset.storage_backend='r2'",
    );
    expect(normalized).toContain(
      "AND EXISTS ( SELECT 1 FROM projects target WHERE target.id=$2 AND target.deleted_at IS NULL )",
    );
    expect(normalized).toContain(
      "AND ( asset.project_id=$2 OR EXISTS ( SELECT 1 FROM asset_usage usage WHERE usage.asset_id=asset.id AND usage.project_id=$2 AND usage.consumer=$3 AND usage.artifact_id IS NULL AND usage.version_id IS NULL AND usage.file_path IS NULL ) )",
    );
    expect(normalized).not.toContain("project-asset-history");
    const admitted =
      fixture.productScope === "nabuflow" &&
      (fixture.state ?? "ready") === "ready" &&
      fixture.targetActive !== false &&
      (fixture.assetProjectId === 9 ||
        fixture.usages.some(
          (usage) =>
            usage.assetId === 71 &&
            usage.projectId === 9 &&
            usage.consumer === "explicit-project-use:v1" &&
            usage.artifactId === null &&
            usage.versionId === null &&
            usage.filePath === null,
        ));
    return {
      rows: admitted
        ? [
            {
              storage_key: "private/asset-71",
              size_bytes: String(fixtureBytes.length),
              sha256: fixtureSha,
            },
          ]
        : [],
    };
  });
  mocks.readAssetBuffer.mockResolvedValue(fixtureBytes);
}

describe("project-file asset reference", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.readAssetBuffer.mockReset();
  });
  it("round-trips a bounded typed manifest without carrying bytes or a storage key", () => {
    const sha256 = "a".repeat(64);
    const encoded = encodeProjectFileAssetReference({ assetId: 42, sizeBytes: 1234, sha256 });

    expect(encoded).toBe(`@nabuflow/asset-ref:v1:42:1234:${sha256}`);
    expect(parseProjectFileAssetReference(encoded)).toEqual({
      kind: "project-file-asset-v1",
      assetId: 42,
      sizeBytes: 1234,
      sha256,
    });
    expect(encoded).not.toContain("storage");
    expect(encoded).not.toContain("base64");
  });

  it("fails closed on malformed or oversized manifests", () => {
    expect(
      parseProjectFileAssetReference("@nabuflow/asset-ref:v1:0:1:" + "a".repeat(64)),
    ).toBeNull();
    expect(parseProjectFileAssetReference("@nabuflow/asset-ref:v1:1:1:not-a-hash")).toBeNull();
    expect(() =>
      encodeProjectFileAssetReference({
        assetId: 1,
        sizeBytes: MAX_PROJECT_FILE_ASSET_BYTES + 1,
        sha256: "b".repeat(64),
      }),
    ).toThrow("project_file_asset_reference_invalid");
  });

  it("resolves exact immutable bytes before runtime and client boundaries", async () => {
    const bytes = Buffer.from([0, 255, 1, 2, 128]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const content = encodeProjectFileAssetReference({
      assetId: 71,
      sizeBytes: bytes.length,
      sha256,
    });
    mocks.query.mockResolvedValueOnce({
      rows: [{ storage_key: "private/asset-71", size_bytes: String(bytes.length), sha256 }],
    });
    mocks.readAssetBuffer.mockResolvedValueOnce(bytes);

    const [binary, text] = await resolveProjectRuntimeFiles(9, [
      { path: "public/logo.png", content },
      { path: "src/index.ts", content: "export const ok = true;" },
    ]);

    expect(binary?.content).toBeInstanceOf(Uint8Array);
    expect([...((binary?.content as Uint8Array) ?? [])]).toEqual([...bytes]);
    expect(binary?.content).not.toBe(content);
    expect(text?.content).toBe("export const ok = true;");
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), [
      71,
      9,
      "explicit-project-use:v1",
    ]);

    mocks.query.mockResolvedValueOnce({
      rows: [{ storage_key: "private/asset-71", size_bytes: String(bytes.length), sha256 }],
    });
    mocks.readAssetBuffer.mockResolvedValueOnce(bytes);
    await expect(
      resolveProjectFileClientContent({
        projectId: 9,
        content,
        mimeType: "image/png",
      }),
    ).resolves.toBe(bytes.toString("base64"));
    expect(projectFileByteSize({ content, mimeType: "image/png" })).toBe(bytes.length);
  });

  it.each([
    { name: "current-project asset without history", assetProjectId: 9, usages: [] },
    { name: "explicitly reused project asset", assetProjectId: 10, usages: [exactTargetGrant] },
    { name: "explicitly reused account asset", assetProjectId: null, usages: [exactTargetGrant] },
  ])("delivers a $name", async ({ assetProjectId, usages }) => {
    mockScopedDelivery({ productScope: "nabuflow", assetProjectId, usages });
    await expect(
      resolveProjectFileClientContent({
        projectId: 9,
        content: fixtureContent,
        mimeType: "image/png",
      }),
    ).resolves.toBe(fixtureBytes.toString("base64"));
    expect(mocks.readAssetBuffer).toHaveBeenCalledWith("private/asset-71", fixtureBytes.length);
  });

  const deniedFixtures: Array<AccessFixture & { name: string }> = [
    {
      name: "unknown same-project provenance",
      productScope: null,
      assetProjectId: 9,
      usages: [exactTargetGrant],
    },
    {
      name: "Ora same-project provenance",
      productScope: "ora",
      assetProjectId: 9,
      usages: [exactTargetGrant],
    },
    {
      name: "automatic history only",
      productScope: "nabuflow",
      assetProjectId: 10,
      usages: [{ ...exactTargetGrant, consumer: "project-asset-history" }],
    },
    {
      name: "automatic project-file usage only",
      productScope: "nabuflow",
      assetProjectId: 10,
      usages: [{ ...exactTargetGrant, consumer: "project-file" }],
    },
    {
      name: "another target's grant",
      productScope: "nabuflow",
      assetProjectId: 10,
      usages: [{ ...exactTargetGrant, projectId: 10 }],
    },
    {
      name: "another asset's grant",
      productScope: "nabuflow",
      assetProjectId: 10,
      usages: [{ ...exactTargetGrant, assetId: 72 }],
    },
    {
      name: "artifact-scoped marker",
      productScope: "nabuflow",
      assetProjectId: 10,
      usages: [{ ...exactTargetGrant, artifactId: 2 }],
    },
    {
      name: "version-scoped marker",
      productScope: "nabuflow",
      assetProjectId: 10,
      usages: [{ ...exactTargetGrant, versionId: 2 }],
    },
    {
      name: "file-scoped marker",
      productScope: "nabuflow",
      assetProjectId: 10,
      usages: [{ ...exactTargetGrant, filePath: "public/copied.png" }],
    },
    { name: "no target grant", productScope: "nabuflow", assetProjectId: 10, usages: [] },
    {
      name: "retired target",
      productScope: "nabuflow",
      assetProjectId: 9,
      targetActive: false,
      usages: [exactTargetGrant],
    },
    {
      name: "non-ready asset",
      productScope: "nabuflow",
      assetProjectId: 9,
      state: "deleting",
      usages: [exactTargetGrant],
    },
  ];
  it.each(deniedFixtures)("denies $name before R2 or runtime delivery", async (fixture) => {
    mockScopedDelivery(fixture);
    await expect(
      resolveProjectRuntimeFiles(9, [{ path: "public/private.png", content: fixtureContent }]),
    ).rejects.toThrow("project_file_asset_reference_unavailable");
    await expect(
      resolveProjectFileClientContent({
        projectId: 9,
        content: fixtureContent,
        mimeType: "image/png",
      }),
    ).rejects.toThrow("project_file_asset_reference_unavailable");
    expect(mocks.readAssetBuffer).not.toHaveBeenCalled();
  });

  it("keeps digest verification after product/target admission", async () => {
    mockScopedDelivery({ productScope: "nabuflow", assetProjectId: 9, usages: [] });
    mocks.readAssetBuffer.mockResolvedValue(Buffer.from([0, 254, 1, 2, 128]));
    await expect(
      resolveProjectFileBytes({
        projectId: 9,
        content: fixtureContent,
        mimeType: "image/png",
      }),
    ).rejects.toThrow("project_file_asset_reference_mismatch");
  });

  it("pins only known current-project NabuFlow retention, never an explicit grant", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1 });
    await pinProjectFileAssetHistory({ assetId: 71, projectId: 9 });
    const [statement, parameters] = mocks.query.mock.calls[0]!;
    const normalized = String(statement).replace(/\s+/gu, " ");
    expect(parameters).toEqual([71, 9, "project-asset-history"]);
    expect(normalized).toContain("asset.id=$1 AND asset.project_id=$2 AND asset.state='ready'");
    expect(normalized).toContain("AND asset.product_scope='nabuflow'");
    expect(normalized).toContain("target.id=$2 AND target.deleted_at IS NULL");
    expect(normalized).not.toContain("explicit-project-use:v1");
    mocks.query.mockResolvedValueOnce({ rowCount: 0 });
    await expect(pinProjectFileAssetHistory({ assetId: 71, projectId: 9 })).rejects.toThrow(
      "project_file_asset_reference_unavailable",
    );
  });

  it("preserves text and reports actual legacy binary bytes", async () => {
    await expect(
      resolveProjectFileClientContent({
        projectId: 9,
        content: "plain text",
        mimeType: "text/plain",
      }),
    ).resolves.toBe("plain text");
    expect(
      projectFileByteSize({
        content: Buffer.from([0, 1, 2]).toString("base64"),
        mimeType: "application/octet-stream",
      }),
    ).toBe(3);
  });
});
