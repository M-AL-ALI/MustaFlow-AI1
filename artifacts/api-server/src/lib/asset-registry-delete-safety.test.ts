import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  pool: {
    connect: vi.fn(async () => ({ query, release })),
    query: vi.fn(),
  },
}));

import { AssetAdmissionError, deleteReadyAsset } from "./asset-registry";

const readyRow = {
  storage_key: "accounts/owner/projects/51/asset.png",
  storage_backend: "r2",
  size_bytes: "42",
  state: "ready",
  version_id: null,
  task_id: null,
  message_id: null,
};

describe("asset deletion reference proof", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
  });

  it("refuses deletion when any durable consumer still points at the asset", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRow] })
      .mockResolvedValueOnce({ rows: [{ referenced: true }] })
      .mockResolvedValueOnce({});

    await expect(
      deleteReadyAsset({ assetId: 17, userId: "owner", storageBackend: "r2" }),
    ).rejects.toMatchObject({
      code: "asset_referenced",
      status: 409,
    } satisfies Partial<AssetAdmissionError>);

    const proof = String(query.mock.calls[2]?.[0]);
    for (const durableStore of [
      "asset_usage",
      "generated_images",
      "chat_messages",
      "agent_tasks",
      "agent_tool_calls",
      "zero_prompt_queue_items",
      "knowledge_entries",
      "project_files",
      "project_versions",
      "canvas_variants",
      "canvas_variant_library",
      "gallery_templates",
      "agent_inbox",
      "task_events",
      "project_activity",
      "visual_edit_changes",
      "asset_analysis_events",
      "derivativeOfAssetId",
    ]) {
      expect(proof).toContain(durableStore);
    }
    expect(proof).toContain("WITH candidate AS");
    expect(proof).toContain("project_id IS NOT DISTINCT FROM (SELECT project_id FROM candidate)");
    expect(proof).toContain("owner_user_id = (SELECT owner_user_id FROM candidate)");
    expect(query.mock.calls[2]?.[1]).toEqual([17, "owner", null]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("treats an asset's version, task, or message binding as a durable reference", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...readyRow, version_id: 149 }],
      })
      .mockResolvedValueOnce({ rows: [{ referenced: false }] })
      .mockResolvedValueOnce({});

    await expect(
      deleteReadyAsset({ assetId: 17, userId: "owner", storageBackend: "r2" }),
    ).rejects.toMatchObject({ code: "asset_referenced" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("returns provider deletion material only after every durable reference is absent", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRow] })
      .mockResolvedValueOnce({ rows: [{ referenced: false }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            storage_key: readyRow.storage_key,
            storage_backend: readyRow.storage_backend,
            size_bytes: readyRow.size_bytes,
          },
        ],
      })
      .mockResolvedValueOnce({});

    await expect(
      deleteReadyAsset({ assetId: 17, userId: "owner", storageBackend: "r2" }),
    ).resolves.toEqual({
      storageKey: readyRow.storage_key,
      storageBackend: "r2",
      sizeBytes: 42,
      storageObjects: [{ storageKey: readyRow.storage_key, storageBackend: "r2", sizeBytes: 42 }],
    });
    expect(String(query.mock.calls[3]?.[0])).toContain("SET state='deleting'");
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("resumes an interrupted provider deletion from its durable deleting claim", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...readyRow, state: "deleting" }],
      })
      .mockResolvedValueOnce({ rows: [{ referenced: false }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            storage_key: readyRow.storage_key,
            storage_backend: readyRow.storage_backend,
            size_bytes: readyRow.size_bytes,
          },
        ],
      })
      .mockResolvedValueOnce({});

    await expect(
      deleteReadyAsset({ assetId: 17, userId: "owner", storageBackend: "r2" }),
    ).resolves.toEqual({
      storageKey: readyRow.storage_key,
      storageBackend: "r2",
      sizeBytes: 42,
      storageObjects: [{ storageKey: readyRow.storage_key, storageBackend: "r2", sizeBytes: 42 }],
    });
    expect(
      query.mock.calls.some(
        ([statement]) =>
          String(statement).includes("UPDATE assets SET state='deleting'") &&
          String(statement).includes("state='ready'"),
      ),
    ).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("treats a historical URL-only asset as metadata-only deletion work", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...readyRow, storage_backend: "legacy-url", storage_key: "legacy-generated/9" }],
      })
      .mockResolvedValueOnce({ rows: [{ referenced: false }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});

    await expect(deleteReadyAsset({ assetId: 17, userId: "owner" })).resolves.toMatchObject({
      storageBackend: "legacy-url",
      storageObjects: [],
    });
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("can exclude only the owned gallery row being deleted while claiming storage", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRow] })
      .mockResolvedValueOnce({ rows: [{ referenced: false }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});

    await deleteReadyAsset({
      assetId: 17,
      userId: "owner",
      generatedImageIdBeingDeleted: 91,
    });
    expect(String(query.mock.calls[2]?.[0])).toContain("image.id <> COALESCE($3, -1)");
    expect(String(query.mock.calls[2]?.[0])).toContain(
      "($3::integer IS NULL OR consumer <> 'generated-image:' || $3::text)",
    );
    expect(query.mock.calls[2]?.[1]).toEqual([17, "owner", 91]);
  });
});
