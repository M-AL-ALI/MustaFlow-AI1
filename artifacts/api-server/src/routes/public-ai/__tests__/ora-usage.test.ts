import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mock @workspace/db: keep the REAL tier limit constants + table object, but
// replace `db` with an in-memory stub so the quota logic is exercised without a
// live Postgres connection. importActual preserves TIER_DAILY_* so we genuinely
// assert the shipped limits (free 15/3, core 30/10, wave 55/20). ────────────────
// vi.mock factories are hoisted above top-level declarations, so the shared mock
// state must live inside vi.hoisted to be referenceable from the factory.
const h = vi.hoisted(() => {
  const selectWhere = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
  const returning = vi.fn().mockResolvedValue([{ messageCount: 1, imageCount: 0 }]);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const capturedInsertValues: Array<Record<string, unknown>> = [];
  const mockDb = {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => selectWhere(...args),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        capturedInsertValues.push(v);
        return { onConflictDoUpdate: (cfg: unknown) => onConflictDoUpdate(cfg) };
      },
    }),
    update: () => ({ set: updateSet }),
  };
  return { selectWhere, onConflictDoUpdate, returning, updateSet, capturedInsertValues, mockDb };
});
const { selectWhere, onConflictDoUpdate, returning, updateSet, capturedInsertValues } = h;

vi.mock("@workspace/db", async () => {
  const schema = await import("../../../../../../lib/db/src/schema/index");
  return { ...schema, db: h.mockDb };
});

import {
  oraUsageDate,
  getTodayOraUsage,
  checkOraQuota,
  consumeOraQuota,
  refundOraQuota,
  incrementOraMessage,
  incrementOraImage,
  oraMessageFields,
} from "../../../lib/public-ai/ora-usage";
import { MSG_LIMIT_VALUE } from "../../../lib/public-ai/session";

beforeEach(() => {
  selectWhere.mockReset();
  selectWhere.mockResolvedValue([]);
  returning.mockReset();
  returning.mockResolvedValue([{ messageCount: 1, imageCount: 0 }]);
  updateSet.mockClear();
  onConflictDoUpdate.mockClear();
  capturedInsertValues.length = 0;
});

describe("oraUsageDate — UTC calendar day", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(oraUsageDate(new Date("2026-06-05T13:45:00Z"))).toBe("2026-06-05");
  });

  it("rolls over at midnight UTC, not local time", () => {
    // 23:30 UTC and 00:30 UTC of the next day are different buckets.
    expect(oraUsageDate(new Date("2026-06-05T23:30:00Z"))).toBe("2026-06-05");
    expect(oraUsageDate(new Date("2026-06-06T00:30:00Z"))).toBe("2026-06-06");
  });
});

describe("getTodayOraUsage — tier limits + counts", () => {
  it("maps each tier to its shipped daily limits", async () => {
    const free = await getTodayOraUsage("u1", "free");
    expect(free.messageLimit).toBe(15);
    expect(free.imageLimit).toBe(3);

    const core = await getTodayOraUsage("u1", "core");
    expect(core.messageLimit).toBe(30);
    expect(core.imageLimit).toBe(10);

    const wave = await getTodayOraUsage("u1", "wave");
    expect(wave.messageLimit).toBe(55);
    expect(wave.imageLimit).toBe(20);
  });

  it("defaults an unknown tier to free limits", async () => {
    const usage = await getTodayOraUsage("u1", "enterprise-typo");
    expect(usage.messageLimit).toBe(15);
    expect(usage.imageLimit).toBe(3);
  });

  it("returns zero counts when no row exists yet", async () => {
    selectWhere.mockResolvedValue([]);
    const usage = await getTodayOraUsage("u1", "core");
    expect(usage.messageCount).toBe(0);
    expect(usage.imageCount).toBe(0);
  });

  it("reflects stored counts when a row exists", async () => {
    selectWhere.mockResolvedValue([{ messageCount: 7, imageCount: 2 }]);
    const usage = await getTodayOraUsage("u1", "core");
    expect(usage.messageCount).toBe(7);
    expect(usage.imageCount).toBe(2);
  });

  it("fails open to zero counts when the table read throws", async () => {
    selectWhere.mockRejectedValue(new Error("relation does not exist"));
    const usage = await getTodayOraUsage("u1", "wave");
    expect(usage.messageCount).toBe(0);
    expect(usage.imageCount).toBe(0);
    // Limits still resolve so enforcement remains correct.
    expect(usage.messageLimit).toBe(55);
  });
});

describe("checkOraQuota — bucket routing + cap", () => {
  it("allows a message when under the message limit", async () => {
    selectWhere.mockResolvedValue([{ messageCount: 14, imageCount: 0 }]);
    const res = await checkOraQuota("u1", "free", "message");
    expect(res).toEqual({ allowed: true, used: 14, limit: 15, kind: "message" });
  });

  it("blocks a message exactly at the message limit", async () => {
    selectWhere.mockResolvedValue([{ messageCount: 15, imageCount: 0 }]);
    const res = await checkOraQuota("u1", "free", "message");
    expect(res.allowed).toBe(false);
    expect(res.used).toBe(15);
    expect(res.limit).toBe(15);
  });

  it("routes the image bucket to the image counter/limit, independent of messages", async () => {
    selectWhere.mockResolvedValue([{ messageCount: 99, imageCount: 3 }]);
    const res = await checkOraQuota("u1", "free", "image");
    expect(res.kind).toBe("image");
    expect(res.used).toBe(3);
    expect(res.limit).toBe(3);
    expect(res.allowed).toBe(false); // image cap hit even though messages irrelevant
  });
});

describe("increment helpers — atomic upsert payloads", () => {
  it("incrementOraMessage inserts a message=1/image=0 row and upserts", async () => {
    await incrementOraMessage("u1");
    expect(capturedInsertValues).toHaveLength(1);
    expect(capturedInsertValues[0]).toMatchObject({
      userId: "u1",
      messageCount: 1,
      imageCount: 0,
    });
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("incrementOraImage inserts a message=0/image=1 row and upserts", async () => {
    await incrementOraImage("u1");
    expect(capturedInsertValues).toHaveLength(1);
    expect(capturedInsertValues[0]).toMatchObject({
      userId: "u1",
      messageCount: 0,
      imageCount: 1,
    });
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("consumeOraQuota", () => {
  it("returns the atomic reservation result from the database", async () => {
    returning.mockResolvedValue([{ messageCount: 15, imageCount: 0 }]);
    const res = await consumeOraQuota("u1", "free", "message");
    expect(res).toEqual({ allowed: true, used: 15, limit: 15, kind: "message" });
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("blocks when the conditional update did not reserve capacity", async () => {
    returning.mockResolvedValue([]);
    selectWhere.mockResolvedValue([{ messageCount: 15, imageCount: 0 }]);
    const res = await consumeOraQuota("u1", "free", "message");
    expect(res.allowed).toBe(false);
    expect(res.used).toBe(15);
  });

  it("refunds quota best-effort without throwing", async () => {
    await refundOraQuota("u1", "image");
    expect(updateSet).toHaveBeenCalledTimes(1);
  });
});

describe("oraMessageFields — anon vs authed", () => {
  it("anonymous visitors get the per-session counter + session limit", async () => {
    const fields = await oraMessageFields(null, 4);
    expect(fields).toEqual({ msgCount: 4, msgLimit: MSG_LIMIT_VALUE });
  });

  it("signed-in users get today's daily message usage + tier limit", async () => {
    selectWhere.mockResolvedValue([{ messageCount: 9, imageCount: 1 }]);
    const fields = await oraMessageFields({ userId: "u1", tier: "core" }, 4);
    expect(fields).toEqual({ msgCount: 9, msgLimit: 30 });
  });
});

// ─── Isolation guard: Ora usage must never reach into the Builder's billing. ────
describe("Ora/Builder isolation", () => {
  it("ora-usage source does not import builder/ai/jobs/credits modules", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "../../../lib/public-ai/ora-usage.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+["'].*\/builder["']/);
    expect(src).not.toMatch(/from\s+["'].*\/ai["']/);
    expect(src).not.toMatch(/from\s+["'].*\/jobs["']/);
    expect(src).not.toMatch(/deductCreditsAtomic/);
  });
});
