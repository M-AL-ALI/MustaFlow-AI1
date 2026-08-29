import { describe, expect, it } from "vitest";
import {
  acceptsDeclaredAsset,
  BASE_ASSET_ALLOWANCE_BYTES,
  quotaMessage,
  sniffAsset,
} from "./asset-contract";

describe("unified asset contract", () => {
  it("pins the founder's one account allowance", () => {
    expect(BASE_ASSET_ALLOWANCE_BYTES).toBe(500 * 1024 * 1024);
    expect(
      quotaMessage({ usedBytes: 125 * 1024 * 1024, limitBytes: BASE_ASSET_ALLOWANCE_BYTES }),
    ).toBe("This upload would exceed your 500.0 MB storage allowance. You are using 125.0 MB.");
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
