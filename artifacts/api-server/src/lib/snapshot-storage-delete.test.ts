import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deleteObject: vi.fn() }));

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket() {
      return {
        file: () => ({ delete: mocks.deleteObject }),
      };
    }
  },
}));

vi.mock("./logger", () => ({ logger: { warn: vi.fn() } }));

import { deleteSnapshotBlob } from "./snapshot-storage";

describe("snapshot storage deletion receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID = "test-bucket";
  });

  afterEach(() => {
    delete process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  });

  it("confirms an inline snapshot without contacting object storage", async () => {
    await expect(deleteSnapshotBlob(null)).resolves.toBe(true);
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });

  it("awaits an idempotent provider delete before confirming absence", async () => {
    mocks.deleteObject.mockResolvedValue(undefined);
    await expect(deleteSnapshotBlob("db-snapshots/51/one.sql")).resolves.toBe(true);
    expect(mocks.deleteObject).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it("refuses confirmation when the provider delete fails", async () => {
    mocks.deleteObject.mockRejectedValue(new Error("unavailable"));
    await expect(deleteSnapshotBlob("db-snapshots/51/one.sql")).resolves.toBe(false);
  });
});
