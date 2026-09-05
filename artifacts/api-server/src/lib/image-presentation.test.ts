import { describe, expect, it } from "vitest";
import { presentPrivateImage } from "./image-presentation";

describe("private image presentation", () => {
  it("never exposes a stored private R2 URL to the browser", () => {
    const row = presentPrivateImage({
      id: 42,
      assetId: 81,
      productScope: "nabuflow",
      status: "completed",
      storageKey: "assets/private/project-51/00000000-0000-4000-8000-000000000042/full.webp",
      fileUrl: "https://private-bucket.invalid/full.webp",
      thumbnailUrl: "https://private-bucket.invalid/thumb.webp",
    });
    expect(row.fileUrl).toBe("/api/assets/81/content");
    expect(row.thumbnailUrl).toBe("/api/assets/81/content");
    expect(row).not.toHaveProperty("storageKey");
    expect(JSON.stringify(row)).not.toContain("00000000-0000-4000-8000-000000000042");
    expect(JSON.stringify(row)).not.toContain("private-bucket.invalid");
  });

  it("does not expose unclassified legacy bytes through a fallback route", () => {
    const row = presentPrivateImage({ id: 42, assetId: null, status: "completed" });
    expect(row.fileUrl).toBeNull();
    expect(row.thumbnailUrl).toBeNull();
  });

  it("uses Ora canonical IDs without treating them as Ora library IDs", () => {
    const row = presentPrivateImage({
      id: 42,
      assetId: 81,
      status: "completed",
      productScope: "ora",
    });
    expect(row.fileUrl).toBe("/api/ora/canonical-assets/81/content");
    expect(row.thumbnailUrl).toBe(row.fileUrl);
  });

  it.each([null, undefined, "unknown"])("hides an unknown product scope: %s", (productScope) => {
    const row = presentPrivateImage({ id: 42, assetId: 81, status: "completed", productScope });
    expect(row.fileUrl).toBeNull();
    expect(row.thumbnailUrl).toBeNull();
  });

  it("does not claim unfinished bytes exist", () => {
    const row = presentPrivateImage({ id: 7, status: "generating" });
    expect(row.fileUrl).toBeNull();
    expect(row.thumbnailUrl).toBeNull();
  });
});
