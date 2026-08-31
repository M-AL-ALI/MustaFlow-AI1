import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), readAssetBuffer: vi.fn() }));

vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));
vi.mock("./asset-r2", () => ({ readAssetBuffer: mocks.readAssetBuffer }));
import {
  encodeProjectFileAssetReference,
  MAX_PROJECT_FILE_ASSET_BYTES,
  parseProjectFileAssetReference,
  projectFileByteSize,
  resolveProjectFileClientContent,
  resolveProjectRuntimeFiles,
} from "./project-file-asset-reference";

describe("project-file asset reference", () => {
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
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), [71, 9, "project-asset-history"]);

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
