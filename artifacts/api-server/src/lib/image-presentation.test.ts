import { describe, expect, it } from "vitest";
import { presentPrivateImage } from "./image-presentation";

describe("private image presentation", () => {
  it("never exposes a stored private R2 URL to the browser", () => {
    const row = presentPrivateImage({
      id: 42,
      assetId: 81,
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

  it("keeps the authenticated legacy image route only for a row not yet linked to an asset", () => {
    const row = presentPrivateImage({ id: 42, assetId: null, status: "completed" });
    expect(row.fileUrl).toBe("/api/images/42/file");
    expect(row.thumbnailUrl).toBe("/api/images/42/file?role=thumbnail");
  });

  it("does not claim unfinished bytes exist", () => {
    const row = presentPrivateImage({ id: 7, status: "generating" });
    expect(row.fileUrl).toBeNull();
    expect(row.thumbnailUrl).toBeNull();
  });
});
