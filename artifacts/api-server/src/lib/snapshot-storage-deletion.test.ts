import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteObject: vi.fn(),
  objectExists: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket() {
      return {
        file: () => ({ delete: mocks.deleteObject, exists: mocks.objectExists }),
      };
    }
  },
}));

vi.mock("./logger", () => ({ logger: { warn: mocks.warn } }));

import { deleteSnapshotBlobAndProveAbsent, snapshotBlobExists } from "./snapshot-storage";

describe("snapshot storage deletion absence proof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID = "test-bucket";
  });

  afterEach(() => {
    delete process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  });

  it("proves provider absence after an idempotent delete", async () => {
    mocks.deleteObject.mockResolvedValue(undefined);
    mocks.objectExists.mockResolvedValue([false]);

    await expect(deleteSnapshotBlobAndProveAbsent("db-snapshots/51/one.sql")).resolves.toBe(true);
    expect(mocks.deleteObject).toHaveBeenCalledWith({ ignoreNotFound: true });
    expect(mocks.objectExists).toHaveBeenCalledOnce();
  });

  it("refuses success while the object is still visible", async () => {
    mocks.deleteObject.mockResolvedValue(undefined);
    mocks.objectExists.mockResolvedValue([true]);

    await expect(deleteSnapshotBlobAndProveAbsent("db-snapshots/51/one.sql")).resolves.toBe(false);
  });

  it("logs only a safe status and error class when provider deletion fails", async () => {
    mocks.deleteObject.mockRejectedValue(new TypeError("provider body contains a secret"));

    await expect(deleteSnapshotBlobAndProveAbsent("db-snapshots/51/private.sql")).resolves.toBe(
      false,
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      { status: "failed", errorClass: "TypeError" },
      "Snapshot GCS delete could not be confirmed",
    );
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("private.sql");
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("provider body contains a secret");
  });

  it("treats missing provider configuration as unknown, never absent", async () => {
    delete process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;

    await expect(snapshotBlobExists("db-snapshots/51/one.sql")).rejects.toThrow(
      "snapshot_storage_unavailable",
    );
    await expect(deleteSnapshotBlobAndProveAbsent("db-snapshots/51/one.sql")).resolves.toBe(false);
  });

  it("does not require provider evidence for an inline-only snapshot", async () => {
    delete process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
    await expect(deleteSnapshotBlobAndProveAbsent(null)).resolves.toBe(true);
    expect(mocks.deleteObject).not.toHaveBeenCalled();
    expect(mocks.objectExists).not.toHaveBeenCalled();
  });

  it("does not contact storage after the destructive lease is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("project_purge_lease_lost"));
    await expect(
      deleteSnapshotBlobAndProveAbsent("db-snapshots/51/one.sql", controller.signal),
    ).rejects.toThrow("project_purge_lease_lost");
    expect(mocks.deleteObject).not.toHaveBeenCalled();
    expect(mocks.objectExists).not.toHaveBeenCalled();
  });

  it("returns immediately when the lease is lost during an in-flight GCS request", async () => {
    const controller = new AbortController();
    mocks.deleteObject.mockReturnValue(new Promise<never>(() => undefined));
    const deletion = deleteSnapshotBlobAndProveAbsent("db-snapshots/51/one.sql", controller.signal);
    const rejected = expect(deletion).rejects.toThrow("project_purge_lease_lost");
    controller.abort(new Error("project_purge_lease_lost"));
    await rejected;
    expect(mocks.deleteObject).toHaveBeenCalledOnce();
    expect(mocks.objectExists).not.toHaveBeenCalled();
  });
});
