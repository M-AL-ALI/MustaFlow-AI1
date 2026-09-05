import { describe, expect, it } from "vitest";
import {
  acceptsDeclaredAsset,
  BASE_ASSET_ALLOWANCE_BYTES,
  isCanonicalImageFileRequest,
  isCanonicalImageMetadataRequest,
  isCanonicalProjectUploadContentRequest,
  parseCanonicalAssetId,
  quotaMessage,
  sniffAsset,
} from "./asset-contract";
import { canonicalAssetContentUrl } from "./asset-platform-scope";

describe("unified asset contract", () => {
  it("pins the founder's one account allowance", () => {
    expect(BASE_ASSET_ALLOWANCE_BYTES).toBe(500 * 1024 * 1024);
    expect(
      quotaMessage({ usedBytes: 125 * 1024 * 1024, limitBytes: BASE_ASSET_ALLOWANCE_BYTES }),
    ).toBe("This upload would exceed your 500.0 MB storage allowance. You are using 125.0 MB.");
  });

  it("defines one canonical asset URL language for delivery and durable-reference scans", () => {
    expect(parseCanonicalAssetId("51")).toBe(51);
    expect("/api/assets/51/content?download=1".split("?")[0]).toBe(
      canonicalAssetContentUrl(parseCanonicalAssetId("51")!, "nabuflow"),
    );
    for (const [rawUrl, decoded] of [
      ["/api/assets/0051/content", "0051"],
      ["/api/assets/%35%31/content", "51"],
      ["/API/ASSETS/51/CONTENT", "51"],
      ["/api/assets/+51/content", "+51"],
      ["/api/assets/51e0/content", "51e0"],
    ]) {
      const parsed = parseCanonicalAssetId(decoded);
      expect(
        parsed === null || rawUrl.split("?")[0] !== canonicalAssetContentUrl(parsed, "nabuflow"),
      ).toBe(true);
    }
    expect(isCanonicalImageFileRequest("/api/images/51/file?role=thumbnail", "51")).toBe(true);
    expect(isCanonicalImageFileRequest("/api/images/%35%31/file", "51")).toBe(false);
    expect(isCanonicalImageMetadataRequest("/api/images/51", "51")).toBe(true);
    expect(isCanonicalImageMetadataRequest("/api/images/051", "051")).toBe(false);
    expect(
      isCanonicalProjectUploadContentRequest(
        "/api/projects/51/uploads/7/content?download=1",
        "51",
        "7",
      ),
    ).toBe(true);
    for (const [rawUrl, projectId, uploadId] of [
      ["/api/projects/051/uploads/7/content", "051", "7"],
      ["/api/projects/51/uploads/007/content", "51", "007"],
      ["/API/PROJECTS/51/UPLOADS/7/CONTENT", "51", "7"],
      ["/api/projects/%35%31/uploads/7/content", "51", "7"],
    ]) {
      expect(isCanonicalProjectUploadContentRequest(rawUrl, projectId, uploadId)).toBe(false);
    }
  });

  it("keeps canonical delivery namespaces disjoint for the same asset ID", () => {
    expect(canonicalAssetContentUrl(51, "nabuflow")).toBe("/api/assets/51/content");
    expect(canonicalAssetContentUrl(51, "ora")).toBe("/api/ora/canonical-assets/51/content");
    expect(canonicalAssetContentUrl(51, "ora")).not.toBe(canonicalAssetContentUrl(51, "nabuflow"));
    expect(() => canonicalAssetContentUrl(0, "nabuflow")).toThrow();
  });

  it("sniffs content instead of trusting an extension", () => {
    const png = Buffer.from("89504e470d0a1a0a0000000000000000", "hex");
    expect(sniffAsset(png, "proof.png", "image/png")).toBe("image/png");
    expect(sniffAsset(png, "proof.jpg", "image/jpeg")).toBeNull();
    expect(acceptsDeclaredAsset("proof.png", "image/png")).toBe(true);
    expect(acceptsDeclaredAsset("proof.exe", "application/octet-stream")).toBe(false);
  });

  it("refuses generic archives while allowing declared Office containers", () => {
    const zip = Buffer.from("504b030414000000", "hex");
    expect(sniffAsset(zip, "archive.zip", "application/zip")).toBeNull();
    expect(
      sniffAsset(
        zip,
        "roadmap.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("recognizes the bounded recording formats", () => {
    expect(sniffAsset(Buffer.from("1a45dfa300000000", "hex"), "clip.webm", "video/webm")).toBe(
      "video/webm",
    );
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(8)]);
    expect(sniffAsset(mp4, "clip.mp4", "video/mp4")).toBe("video/mp4");
  });
});
