import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class {
    send = send;
  },
}));

import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { headAssetObject } from "./asset-r2";

describe("R2 physical-byte observation", () => {
  beforeEach(() => {
    send.mockReset();
    vi.stubEnv("CF_ACCOUNT_ID", "test-account");
    vi.stubEnv("CF_R2_ACCESS_KEY_ID", "test-access");
    vi.stubEnv("CF_R2_SECRET_ACCESS_KEY", "test-secret");
    vi.stubEnv("CF_R2_BUCKET", "test-bucket");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unverified or invalid ContentLength %s",
    async (ContentLength) => {
      send.mockResolvedValueOnce({ ContentLength });
      await expect(headAssetObject("owned/existing.webp")).rejects.toThrow(
        "asset_storage_size_invalid",
      );
    },
  );

  it.each([0, 123])("accepts explicitly observed %i bytes", async (ContentLength) => {
    send.mockResolvedValueOnce({ ContentLength });
    await expect(headAssetObject("owned/existing.webp")).resolves.toEqual({
      sizeBytes: ContentLength,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[0]![0].input).toEqual({
      Bucket: "test-bucket",
      Key: "owned/existing.webp",
    });
  });

  it("retains provider absence as null", async () => {
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    await expect(headAssetObject("owned/missing.webp")).resolves.toBeNull();
  });

  it("does not turn provider failures into zero bytes or absence", async () => {
    const error = Object.assign(new Error("provider unavailable"), {
      $metadata: { httpStatusCode: 503 },
    });
    send.mockRejectedValueOnce(error);
    await expect(headAssetObject("owned/existing.webp")).rejects.toBe(error);
  });
});
