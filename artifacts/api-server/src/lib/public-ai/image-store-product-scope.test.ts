import { afterEach, describe, expect, it, vi } from "vitest";
import { getImage, storeImage } from "./image-store";

const entry = {
  sessionId: "ora-image-scope-session",
  filename: "image.webp",
  mimeType: "image/webp",
  sizeBytes: 5,
  width: 1,
  height: 1,
  base64: "aW1hZ2U=",
};

afterEach(() => vi.restoreAllMocks());

describe("Ora ephemeral image provenance", () => {
  it("stamps immutable Ora provenance rather than trusting an input property", () => {
    const hostileInput = { ...entry, productScope: "nabuflow" };
    const result = storeImage(hostileInput);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const image = getImage(result.imageRef, entry.sessionId);
    expect(image?.productScope).toBe("ora");
    expect(Object.isFrozen(image)).toBe(true);
  });

  it("does not let known Ora provenance bypass session ownership", () => {
    const result = storeImage(entry);
    if (!result.ok) throw new Error(result.error);
    expect(getImage(result.imageRef, "different-session")).toBeNull();
    expect(getImage(result.imageRef, entry.sessionId)?.productScope).toBe("ora");
  });

  it("keeps the existing expiry boundary", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const result = storeImage(entry);
    if (!result.ok) throw new Error(result.error);
    vi.spyOn(Date, "now").mockReturnValue(1000 + 15 * 60 * 1000);
    expect(getImage(result.imageRef, entry.sessionId)).toBeNull();
  });
});
