import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  accountAssetQuotaTable: {},
  storageAddonSubscriptionsTable: {},
  db: {},
}));

import {
  ASSET_STORAGE_PLANS,
  createAssetStorageCheckout,
  isAssetStorageSku,
} from "./asset-storage-billing";

describe("asset storage billing contract", () => {
  it("publishes the three founder-approved recurring options", () => {
    expect(ASSET_STORAGE_PLANS.storage_5gb.monthlyCents).toBe(199);
    expect(ASSET_STORAGE_PLANS.storage_25gb.monthlyCents).toBe(499);
    expect(ASSET_STORAGE_PLANS.storage_100gb.monthlyCents).toBe(1299);
    expect(isAssetStorageSku("storage_25gb")).toBe(true);
    expect(isAssetStorageSku("unlimited")).toBe(false);
  });

  it("creates a namespaced checkout whose webhook can provision the exact allowance", async () => {
    const create = vi.fn(async () => ({ id: "cs_storage", url: "https://checkout.example" }));
    const stripe = {
      prices: { list: vi.fn(async () => ({ data: [{ id: "price_storage" }] })) },
      products: { create: vi.fn() },
      checkout: { sessions: { create } },
    };

    await expect(
      createAssetStorageCheckout({
        stripe: stripe as never,
        customerId: "cus_owner",
        userId: "owner-1",
        sku: "storage_5gb",
        returnBase: "https://www.mustaflow.com",
      }),
    ).resolves.toEqual({ id: "cs_storage", url: "https://checkout.example" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer: "cus_owner",
        metadata: expect.objectContaining({
          surface: "asset_storage",
          userId: "owner-1",
          sku: "storage_5gb",
          allowanceBytes: String(5 * 1024 * 1024 * 1024),
        }),
      }),
    );
  });
});
