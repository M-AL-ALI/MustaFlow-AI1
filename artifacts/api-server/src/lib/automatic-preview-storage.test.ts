import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  reject: vi.fn(),
  remove: vi.fn(),
  head: vi.fn(),
  reserve: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  put: vi.fn(),
  admit: vi.fn(),
  supports: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));
vi.mock("./asset-registry", () => ({
  rejectReservedAsset: mocks.reject,
  reserveAsset: mocks.reserve,
  beginAssetUpload: mocks.begin,
  completeAsset: mocks.complete,
}));
vi.mock("./asset-r2", () => ({
  deleteAssetObject: mocks.remove,
  headAssetObject: mocks.head,
  putAssetBuffer: mocks.put,
}));
vi.mock("./project-lifecycle", () => ({
  withActiveProjectLifecycle: vi.fn(),
  registerProjectWorkController: vi.fn(),
}));
vi.mock("./preview-version-provenance", () => ({
  bindPreviewVersion: vi.fn(() => ({ state: "verified" })),
  readPreviewVersionWitness: vi.fn(),
}));
vi.mock("./automatic-preview-admission", () => ({
  automaticPreviewAdmitted: mocks.admit,
}));
vi.mock("./tenant-runtime", () => ({
  tenantRuntimeProvider: { captureProjectPreview: mocks.capture },
}));
vi.mock("./tenant-runtime-provider", () => ({
  supportsProjectPreviewCapture: mocks.supports,
}));

import {
  automaticPreviewDependencies,
  cleanupAutomaticPreview,
  readAutomaticPreviewAttempts,
} from "./automatic-preview-storage";

const asset = { id: 700, storageKey: "assets/owner/project-81/700.png" };
const project = { id: 81, ownerId: "owner" };
const witness = {
  projectId: 81,
  versionId: 100,
  sourceSha256: "a".repeat(64),
  runtimeIdentity: "runtime-81",
  manifestRevision: "m1",
  sealedArtifactSha256: "b".repeat(64),
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.reject.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.head.mockResolvedValue(null);
  mocks.put.mockResolvedValue(undefined);
  mocks.admit.mockResolvedValue(true);
  mocks.supports.mockReturnValue(true);
  mocks.capture.mockResolvedValue({ ok: true });
});

function allowCleanup() {
  mocks.query
    .mockResolvedValueOnce({ rows: [{ id: asset.id }] })
    .mockResolvedValueOnce({ rows: [{ storage_key: asset.storageKey }] })
    .mockResolvedValueOnce({ rows: [] });
}

function unresolvedCleanup(state = "uploading", putState: string | null = "pending") {
  mocks.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ state, put_state: putState }] });
}

function acknowledgeUpload() {
  mocks.query
    .mockResolvedValueOnce({ rows: [{ id: asset.id }] })
    .mockResolvedValueOnce({ rows: [{ id: asset.id }] });
}

describe("automatic preview durable storage cleanup", () => {
  it.each(["ready", "deleted", "deleting"])(
    "never deletes an asset now in %s state",
    async (state) => {
      mocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ state, put_state: "acknowledged" }] });
      await cleanupAutomaticPreview(asset, project);
      expect(mocks.reject).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.head).not.toHaveBeenCalled();
      expect(mocks.query.mock.calls[0]![0]).toContain(
        "state IN ('reserved', 'uploading', 'rejected')",
      );
    },
  );

  it("does not delete when the final COMMIT wins the cleanup row lock", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ state: "ready", put_state: "acknowledged" }],
    });
    await cleanupAutomaticPreview(asset, project);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("does not delete when the final COMMIT wins after the write gate closes", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: asset.id }] })
      .mockResolvedValueOnce({ rows: [] });
    await cleanupAutomaticPreview(asset, project);
    expect(mocks.reject).toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled();
  });

  it("requires a closed write gate, fresh rejected row and provider absence", async () => {
    allowCleanup();
    await cleanupAutomaticPreview(asset, project);
    expect(mocks.query.mock.calls[0]![0]).toContain("IN ('not-started', 'acknowledged', 'closed')");
    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reject.mock.invocationCallOrder[0]!,
    );
    expect(mocks.query.mock.calls[1]![0]).toContain(
      "a.context->'automaticPreview'->>'putState'='closed'",
    );
    expect(mocks.remove).toHaveBeenCalledWith(asset.storageKey);
    expect(mocks.head).toHaveBeenCalledWith(asset.storageKey);
    expect(mocks.query.mock.calls[2]![0]).toContain("state='deleted'");
    expect(mocks.query.mock.calls[2]![1]).toEqual([
      700,
      81,
      "owner",
      asset.storageKey,
      "automatic-preview",
    ]);
  });

  it.each(["reserved", "uploading", "rejected"])(
    "retains unresolved %s rows without releasing quota or claiming absence",
    async (state) => {
      unresolvedCleanup(state);
      await expect(cleanupAutomaticPreview(asset, project)).rejects.toMatchObject({
        code: "automatic_preview_put_uncertain",
      });
      expect(mocks.reject).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.head).not.toHaveBeenCalled();
      expect(mocks.query).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["reserved", "uploading", "rejected"])(
    "treats a legacy %s attempt without write proof as uncertain",
    async (state) => {
      unresolvedCleanup(state, null);
      await expect(cleanupAutomaticPreview(asset, project)).rejects.toMatchObject({
        code: "automatic_preview_put_uncertain",
      });
      expect(mocks.reject).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.head).not.toHaveBeenCalled();
    },
  );

  it("does not record deletion while the object still exists", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: asset.id }] })
      .mockResolvedValueOnce({ rows: [{ storage_key: asset.storageKey }] });
    mocks.head.mockResolvedValueOnce({ sizeBytes: 33 });
    await expect(cleanupAutomaticPreview(asset, project)).rejects.toMatchObject({
      code: "automatic_preview_object_still_present",
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("keeps failed provider removal recoverable", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: asset.id }] })
      .mockResolvedValueOnce({ rows: [{ storage_key: asset.storageKey }] });
    mocks.remove.mockRejectedValueOnce(new Error("provider down"));
    await expect(cleanupAutomaticPreview(asset, project)).rejects.toThrow("provider down");
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.head).not.toHaveBeenCalled();
  });

  it("does not treat an untyped HEAD failure as absence", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: asset.id }] })
      .mockResolvedValueOnce({ rows: [{ storage_key: asset.storageKey }] });
    mocks.head.mockRejectedValueOnce(new Error("HEAD connection lost"));
    await expect(cleanupAutomaticPreview(asset, project)).rejects.toThrow("HEAD connection lost");
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("does not touch absent, other-owner, other-product or other-project rows", async () => {
    await cleanupAutomaticPreview(asset, project);
    for (const [sql, params] of mocks.query.mock.calls) {
      expect(sql).toContain("product_scope='nabuflow'");
      expect(sql).toContain("scope='project'");
      expect(sql).toContain("kind='snapshot'");
      expect(sql).toContain("project_id=$2");
      expect(sql).toContain("actor_user_id=$3");
      expect(sql).toContain("storage_key=$4");
      expect(params).toEqual([700, 81, "owner", asset.storageKey, "automatic-preview"]);
    }
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("reads canonical direct-project attempts without filtering away uncertain uploads", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 700,
          storage_key: asset.storageKey,
          state: "uploading",
          created_at: new Date(0),
          needs_cleanup: false,
        },
      ],
    });
    const attempts = await readAutomaticPreviewAttempts(
      { projectId: 81, versionId: 100, cleanupOnly: true },
      "owner",
      "key",
    );
    expect(attempts).toEqual([
      {
        id: 700,
        storageKey: asset.storageKey,
        state: "uploading",
        createdAt: new Date(0),
        needsCleanup: false,
      },
    ]);
    expect(mocks.query.mock.calls[0]![0]).toContain("a.context->'automaticPreview'->>'key'=$5");
    expect(mocks.query.mock.calls[0]![1]).toEqual(["automatic-preview", 81, 100, "owner", "key"]);
  });

  it("reserves quota and durable no-write proof through the project registry", async () => {
    mocks.reserve.mockResolvedValueOnce(asset);
    await automaticPreviewDependencies.reserve(project, witness, "key");
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        productScope: "nabuflow",
        projectId: 81,
        scope: "project",
        kind: "snapshot",
        source: "automatic-preview",
        versionId: 100,
        ownerUserId: "owner",
        actorUserId: "owner",
        sizeBytes: 4 * 1024 * 1024,
        context: expect.objectContaining({
          route: "/",
          automaticPreview: {
            schema: "automatic-project-preview/v1",
            key: "key",
            putState: "not-started",
          },
        }),
      }),
    );
  });
});

describe("automatic preview durable PUT gate", () => {
  it("persists uncertainty before PUT and terminal acknowledgment before HEAD", async () => {
    acknowledgeUpload();
    mocks.head.mockResolvedValueOnce({ sizeBytes: 33 });
    await automaticPreviewDependencies.upload(
      asset,
      Buffer.alloc(33),
      new AbortController().signal,
    );
    expect(mocks.query.mock.calls[0]![0]).toContain(
      "context->'automaticPreview'->>'putState'='not-started'",
    );
    expect(mocks.query.mock.calls[0]![0]).toContain("'\"pending\"'::jsonb");
    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.put.mock.invocationCallOrder[0]!,
    );
    expect(mocks.query.mock.calls[1]![0]).toContain(
      "context->'automaticPreview'->>'putState'='pending'",
    );
    expect(mocks.query.mock.calls[1]![0]).toContain("'\"acknowledged\"'::jsonb");
    expect(mocks.put.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.query.mock.invocationCallOrder[1]!,
    );
    expect(mocks.query.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.head.mock.invocationCallOrder[0]!,
    );
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });

  it("does not send a PUT if another owner or cleanup already closed its gate", async () => {
    await expect(
      automaticPreviewDependencies.upload(asset, Buffer.alloc(33), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "automatic_preview_reservation_unavailable",
    });
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled();
  });

  it("rejects an already aborted upload before acquiring the write gate", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      automaticPreviewDependencies.upload(asset, Buffer.alloc(33), controller.signal),
    ).rejects.toMatchObject({ code: "automatic_preview_project_inactive" });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("does not dispatch when the durable pending update has an ambiguous response", async () => {
    mocks.query.mockRejectedValueOnce(new Error("pending COMMIT response lost"));
    await expect(
      automaticPreviewDependencies.upload(asset, Buffer.alloc(33), new AbortController().signal),
    ).rejects.toThrow("pending COMMIT response lost");
    unresolvedCleanup();
    await expect(cleanupAutomaticPreview(asset, project)).rejects.toMatchObject({
      code: "automatic_preview_put_uncertain",
    });
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.reject).not.toHaveBeenCalled();
  });

  it("retains quota and uncertainty through a timed-out PUT and a late object", async () => {
    let remoteObject: { sizeBytes: number } | null = null;
    mocks.head.mockImplementation(async () => remoteObject);
    mocks.query.mockResolvedValueOnce({ rows: [{ id: asset.id }] });
    mocks.put.mockRejectedValueOnce(new Error("PUT timed out"));
    await expect(
      automaticPreviewDependencies.upload(asset, Buffer.alloc(33), new AbortController().signal),
    ).rejects.toThrow("PUT timed out");

    unresolvedCleanup();
    await expect(cleanupAutomaticPreview(asset, project)).rejects.toMatchObject({
      code: "automatic_preview_put_uncertain",
    });
    // The remote write completes after the client has already seen failure.
    remoteObject = { sizeBytes: 33 };
    unresolvedCleanup();
    await expect(cleanupAutomaticPreview(asset, project)).rejects.toMatchObject({
      code: "automatic_preview_put_uncertain",
    });
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });

  it("does not clear uncertainty if persisting the PUT acknowledgment fails", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: asset.id }] })
      .mockRejectedValueOnce(new Error("acknowledgment persistence failed"));
    await expect(
      automaticPreviewDependencies.upload(asset, Buffer.alloc(33), new AbortController().signal),
    ).rejects.toThrow("acknowledgment persistence failed");
    unresolvedCleanup();
    await expect(cleanupAutomaticPreview(asset, project)).rejects.toMatchObject({
      code: "automatic_preview_put_uncertain",
    });
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.reject).not.toHaveBeenCalled();
  });

  it("allows cleanup after a successful PUT acknowledgment was durably recorded", async () => {
    acknowledgeUpload();
    mocks.head.mockResolvedValueOnce({ sizeBytes: 33 });
    await automaticPreviewDependencies.upload(
      asset,
      Buffer.alloc(33),
      new AbortController().signal,
    );
    allowCleanup();
    await cleanupAutomaticPreview(asset, project);
    expect(mocks.reject).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(asset.storageKey);
    expect(mocks.query.mock.calls[4]![0]).toContain("state='deleted'");
  });

  it("checks stored length before publishing ready metadata", async () => {
    acknowledgeUpload();
    mocks.head.mockResolvedValueOnce({ sizeBytes: 1 });
    await expect(
      automaticPreviewDependencies.upload(asset, Buffer.alloc(33), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "automatic_preview_storage_size_mismatch",
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});

describe("automatic preview capture admission and dedicated transport", () => {
  it("delegates current capture admission to the shared helper", async () => {
    mocks.admit.mockResolvedValueOnce(false);
    expect(await automaticPreviewDependencies.admit({ projectId: 81, versionId: 100 })).toBe(false);
    expect(mocks.admit).toHaveBeenCalledWith({ projectId: 81, versionId: 100 });
  });

  it("uses one dedicated preview request with the supplied identity and timeout", async () => {
    const signal = new AbortController().signal;
    await automaticPreviewDependencies.capture(witness, signal);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      {
        projectId: 81,
        runtimeIdentity: witness.runtimeIdentity,
        manifestRevision: witness.manifestRevision,
        sealedArtifactSha256: witness.sealedArtifactSha256,
        route: "/",
        viewport: { width: 1280, height: 800 },
      },
      {
        idempotencyKey: expect.any(String),
        timeoutMs: 45_000,
        signal,
      },
    );
  });

  it("does not fall back to generation control when preview capture is unsupported", async () => {
    mocks.supports.mockReturnValueOnce(false);
    await expect(
      automaticPreviewDependencies.capture(witness, new AbortController().signal),
    ).rejects.toMatchObject({ code: "automatic_preview_provider_unavailable" });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not replay a failed renderer request inside the storage adapter", async () => {
    mocks.capture.mockRejectedValueOnce(new Error("renderer response lost"));
    await expect(
      automaticPreviewDependencies.capture(witness, new AbortController().signal),
    ).rejects.toThrow("renderer response lost");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });
});
