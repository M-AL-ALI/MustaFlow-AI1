import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  pool: {
    query,
    connect: vi.fn(),
  },
}));

import { BASE_ASSET_ALLOWANCE_BYTES } from "./asset-contract";
import { getQuota } from "./asset-registry";

describe("asset quota reads never write", () => {
  beforeEach(() => query.mockReset());

  it("returns the base allowance without creating a row", async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(getQuota("account-without-row")).resolves.toEqual({
      usedBytes: 0,
      reservedBytes: 0,
      limitBytes: BASE_ASSET_ALLOWANCE_BYTES,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toMatch(/^SELECT\s/i);
    expect(String(query.mock.calls[0]?.[0])).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });

  it("returns existing counters using one SELECT", async () => {
    query.mockResolvedValue({
      rows: [{ used_bytes: "20", reserved_bytes: "3", limit_bytes: "40" }],
    });

    await expect(getQuota("existing-account")).resolves.toEqual({
      usedBytes: 20,
      reservedBytes: 3,
      limitBytes: 40,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
