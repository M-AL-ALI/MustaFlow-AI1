import { describe, expect, it } from "vitest";
import { presentPrivateImage } from "./image-presentation";

describe("private image presentation", () => {
  it("never exposes a stored private R2 URL to the browser", () => {
    const row = presentPrivateImage({
      id: 42,
      status: "completed",
      fileUrl: "https://private-bucket.invalid/full.webp",
      thumbnailUrl: "https://private-bucket.invalid/thumb.webp",
    });
    expect(row.fileUrl).toBe("/api/images/42/file");
    expect(row.thumbnailUrl).toBe("/api/images/42/file");
    expect(JSON.stringify(row)).not.toContain("private-bucket.invalid");
  });

  it("does not claim unfinished bytes exist", () => {
    const row = presentPrivateImage({ id: 7, status: "generating" });
    expect(row.fileUrl).toBeNull();
    expect(row.thumbnailUrl).toBeNull();
  });
});
