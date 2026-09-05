import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn(async () => ({ query, release })));

vi.mock("@workspace/db", () => ({ pool: { connect } }));

import { reserveAsset } from "./asset-registry";

describe("asset admission during historical storage reconciliation", () => {
  beforeEach(() => {
    query.mockReset();
    connect.mockClear();
    release.mockReset();
  });

  it("fails closed with a typed plain-language refusal before creating quota or asset rows", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ required: true }] })
      .mockResolvedValueOnce({});

    await expect(
      reserveAsset({
        productScope: "nabuflow",
        ownerUserId: "owner",
        actorUserId: "owner",
        projectId: 51,
        threadKey: null,
        scope: "project",
        kind: "generated",
        source: "test",
        filename: "result.webp",
        mimeType: "image/webp",
        sizeBytes: 1,
      }),
    ).rejects.toMatchObject({
      code: "asset_storage_reconciliation_required",
      status: 409,
      message:
        "Your storage total is still being verified. Please try again after storage reconciliation finishes.",
    });

    expect(String(query.mock.calls[1]?.[0])).toContain("asset_storage_objects");
    expect(String(query.mock.calls[1]?.[0])).toContain("asset.owner_user_id=$1");
    expect(String(query.mock.calls[1]?.[0])).toContain("object.size_measured_at IS NULL");
    expect(String(query.mock.calls[1]?.[0])).not.toContain("object.size_bytes=0");
    expect(query.mock.calls[1]?.[1]).toEqual(["owner"]);
    expect(
      query.mock.calls.some(([statement]) => String(statement).includes("INSERT INTO assets")),
    ).toBe(false);
    expect(
      query.mock.calls.some(([statement]) =>
        String(statement).includes("INSERT INTO account_asset_quota"),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("trusted NabuFlow image producer scope", () => {
  it.each([
    ["./agent-loop.ts", 2],
    ["../routes/images.ts", 1],
    ["../routes/snapshot-observe.ts", 1],
    ["../validate-image-generation.ts", 2],
    ["../verify-image-phase-9a2.ts", 3],
  ] as const)(
    "stamps a server-owned literal before producer inputs in %s",
    (path, expectedCalls) => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const calls = [
        ...source.matchAll(
          /\b(?:reserveAsset(?:AgainstAvailableQuota)?|enqueueImage(?:Edit)?Job)\(\s*\{/g,
        ),
      ];
      expect(calls).toHaveLength(expectedCalls);
      for (const call of calls) {
        const inputs = source.slice(call.index! + call[0].length);
        expect(inputs).toMatch(/^\s*productScope:\s*"nabuflow"\s*,/);
      }

      if (path === "../verify-image-phase-9a2.ts") {
        const receipts = [
          ...source.matchAll(/\.insert\(generatedImagesTable\)\s*\.values\(\s*\{/g),
        ];
        expect(receipts).toHaveLength(5);
        for (const receipt of receipts) {
          const values = source.slice(receipt.index! + receipt[0].length);
          expect(values).toMatch(/^\s*productScope:\s*"nabuflow"\s*,/);
        }
      }
    },
  );
});
