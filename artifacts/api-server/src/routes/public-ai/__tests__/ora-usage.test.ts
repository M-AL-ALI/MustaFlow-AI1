import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mock @workspace/db: keep the REAL tier limit constants + table object, but
// replace `db` with an in-memory stub so the rolling-window quota logic is
// exercised without a live Postgres connection. importActual preserves
// TIER_ORA_* so we genuinely assert the shipped limits (free 30/4, core 100/15,
// wave 280/30). ────────────────────────────────────────────────────────────────
// vi.mock factories are hoisted above top-level declarations, so the shared mock
// state must live inside vi.hoisted to be referenceable from the factory.
const h = vi.hoisted(() => {
  const NOW = new Date("2026-06-06T12:00:00Z");
  const selectWhere = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
  const returning = vi
    .fn()
    .mockResolvedValue([{ messageCount: 1, imageCount: 0, windowStart: NOW }]);
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
  return { NOW, selectWhere, onConflictDoUpdate, returning, updateSet, capturedInsertValues, mockDb };
});
const { NOW, selectWhere, onConflictDoUpdate, returning, updateSet, capturedInsertValues } = h;

vi.mock("@workspace/db", async () => {
  const schema = await import("../../../../../../lib/db/src/schema/index");
  return { ...schema, db: h.mockDb };
});

import {
  oraWindowHours,
  getOraUsage,
  checkOraQuota,
  consumeOraQuota,
  refundOraQuota,
  oraMessageFields,
} from "../../../lib/public-ai/ora-usage";
import { MSG_LIMIT_VALUE } from "../../../lib/public-ai/session";

// A window_start far in the future of NOW is "active"; one well in the past is
// "elapsed". We freeze Date so window math is deterministic.
const ACTIVE_START = new Date("2026-06-06T11:00:00Z"); // 1h before NOW
const ELAPSED_START = new Date("2026-06-06T00:00:00Z"); // 12h before NOW

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  selectWhere.mockReset();
  selectWhere.mockResolvedValue([]);
  returning.mockReset();
  returning.mockResolvedValue([{ messageCount: 1, imageCount: 0, windowStart: NOW }]);
  updateSet.mockClear();
  onConflictDoUpdate.mockClear();
  capturedInsertValues.length = 0;
});

describe("oraWindowHours — tier window lengths", () => {
  it("maps each tier to its shipped window length", () => {
    expect(oraWindowHours("free")).toBe(5);
    expect(oraWindowHours("core")).toBe(3);
    expect(oraWindowHours("wave")).toBe(3);
  });

  it("defaults an unknown tier to the free window", () => {
    expect(oraWindowHours("enterprise-typo")).toBe(5);
  });
});

describe("getOraUsage — tier limits + window counts", () => {
  it("maps each tier to its shipped allowances", async () => {
    const free = await getOraUsage("u1", "free");
    expect(free.messageLimit).toBe(30);
    expect(free.imageLimit).toBe(4);
    expect(free.windowHours).toBe(5);

    const core = await getOraUsage("u1", "core");
    expect(core.messageLimit).toBe(100);
    expect(core.imageLimit).toBe(15);
    expect(core.windowHours).toBe(3);

    const wave = await getOraUsage("u1", "wave");
    expect(wave.messageLimit).toBe(280);
    expect(wave.imageLimit).toBe(30);
    expect(wave.windowHours).toBe(3);
  });

  it("defaults an unknown tier to free allowances", async () => {
    const usage = await getOraUsage("u1", "enterprise-typo");
    expect(usage.messageLimit).toBe(30);
    expect(usage.imageLimit).toBe(4);
  });

  it("returns zero counts + null window when no row exists yet", async () => {
    selectWhere.mockResolvedValue([]);
    const usage = await getOraUsage("u1", "core");
    expect(usage.messageCount).toBe(0);
    expect(usage.imageCount).toBe(0);
    expect(usage.windowStart).toBeNull();
    expect(usage.resetsAt).toBeNull();
  });

  it("reflects stored counts + resetsAt when an ACTIVE window row exists", async () => {
    selectWhere.mockResolvedValue([
      { messageCount: 7, imageCount: 2, windowStart: ACTIVE_START },
    ]);
    const usage = await getOraUsage("u1", "core");
    expect(usage.messageCount).toBe(7);
    expect(usage.imageCount).toBe(2);
    expect(usage.windowStart).toBe(ACTIVE_START.toISOString());
    // core window is 3h → resets 3h after the 11:00 start = 14:00Z.
    expect(usage.resetsAt).toBe(new Date("2026-06-06T14:00:00Z").toISOString());
  });

  it("treats an ELAPSED window as fully reset (zeroed, no active window)", async () => {
    selectWhere.mockResolvedValue([
      { messageCount: 99, imageCount: 9, windowStart: ELAPSED_START },
    ]);
    const usage = await getOraUsage("u1", "core");
    expect(usage.messageCount).toBe(0);
    expect(usage.imageCount).toBe(0);
    expect(usage.windowStart).toBeNull();
    expect(usage.resetsAt).toBeNull();
  });

  it("fails open to zero counts when the table read throws", async () => {
    selectWhere.mockRejectedValue(new Error("relation does not exist"));
    const usage = await getOraUsage("u1", "wave");
    expect(usage.messageCount).toBe(0);
    expect(usage.imageCount).toBe(0);
    // Limits still resolve so enforcement remains correct.
    expect(usage.messageLimit).toBe(280);
  });
});

describe("checkOraQuota — bucket routing + cap", () => {
  it("allows a message when under the message limit in an active window", async () => {
    selectWhere.mockResolvedValue([
      { messageCount: 29, imageCount: 0, windowStart: ACTIVE_START },
    ]);
    const res = await checkOraQuota("u1", "free", "message");
    expect(res.allowed).toBe(true);
    expect(res.used).toBe(29);
    expect(res.limit).toBe(30);
    expect(res.kind).toBe("message");
    expect(res.resetsAt).toBe(new Date("2026-06-06T16:00:00Z").toISOString());
  });

  it("blocks a message exactly at the message limit", async () => {
    selectWhere.mockResolvedValue([
      { messageCount: 30, imageCount: 0, windowStart: ACTIVE_START },
    ]);
    const res = await checkOraQuota("u1", "free", "message");
    expect(res.allowed).toBe(false);
    expect(res.used).toBe(30);
    expect(res.limit).toBe(30);
  });

  it("routes the image bucket to the image counter/limit, independent of messages", async () => {
    selectWhere.mockResolvedValue([
      { messageCount: 999, imageCount: 4, windowStart: ACTIVE_START },
    ]);
    const res = await checkOraQuota("u1", "free", "image");
    expect(res.kind).toBe("image");
    expect(res.used).toBe(4);
    expect(res.limit).toBe(4);
    expect(res.allowed).toBe(false); // image cap hit even though messages irrelevant
  });
});

describe("consumeOraQuota — atomic reservation", () => {
  it("inserts an opening row (window_start=now, counter=1) for the message bucket", async () => {
    returning.mockResolvedValue([{ messageCount: 1, imageCount: 0, windowStart: NOW }]);
    const res = await consumeOraQuota("u1", "free", "message");
    expect(res.allowed).toBe(true);
    expect(res.used).toBe(1);
    expect(res.limit).toBe(30);
    expect(capturedInsertValues).toHaveLength(1);
    expect(capturedInsertValues[0]).toMatchObject({ userId: "u1", messageCount: 1, imageCount: 0 });
    // free window 5h → resets 5h after NOW (12:00Z) = 17:00Z.
    expect(res.resetsAt).toBe(new Date("2026-06-06T17:00:00Z").toISOString());
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("inserts an opening row for the image bucket", async () => {
    returning.mockResolvedValue([{ messageCount: 0, imageCount: 1, windowStart: NOW }]);
    const res = await consumeOraQuota("u1", "free", "image");
    expect(res.allowed).toBe(true);
    expect(res.used).toBe(1);
    expect(res.limit).toBe(4);
    expect(capturedInsertValues[0]).toMatchObject({ userId: "u1", messageCount: 0, imageCount: 1 });
  });

  it("returns the atomic reservation result from the database", async () => {
    returning.mockResolvedValue([{ messageCount: 30, imageCount: 0, windowStart: ACTIVE_START }]);
    const res = await consumeOraQuota("u1", "free", "message");
    expect(res.allowed).toBe(true);
    expect(res.used).toBe(30);
    expect(res.limit).toBe(30);
  });

  it("blocks when the conditional update did not reserve capacity", async () => {
    returning.mockResolvedValue([]);
    selectWhere.mockResolvedValue([
      { messageCount: 30, imageCount: 0, windowStart: ACTIVE_START },
    ]);
    const res = await consumeOraQuota("u1", "free", "message");
    expect(res.allowed).toBe(false);
    expect(res.used).toBe(30);
    expect(res.resetsAt).toBe(new Date("2026-06-06T16:00:00Z").toISOString());
  });
});

describe("refundOraQuota", () => {
  it("refunds quota best-effort without throwing", async () => {
    await refundOraQuota("u1", "image");
    expect(updateSet).toHaveBeenCalledTimes(1);
  });
});

describe("oraMessageFields — anon vs authed", () => {
  it("anonymous visitors get the per-session counter + session limit + null reset", async () => {
    const fields = await oraMessageFields(null, 4);
    expect(fields).toEqual({ msgCount: 4, msgLimit: MSG_LIMIT_VALUE, resetsAt: null });
  });

  it("signed-in users get their rolling-window message usage + tier limit + reset", async () => {
    selectWhere.mockResolvedValue([
      { messageCount: 9, imageCount: 1, windowStart: ACTIVE_START },
    ]);
    const fields = await oraMessageFields({ userId: "u1", tier: "core" }, 4);
    expect(fields).toEqual({
      msgCount: 9,
      msgLimit: 100,
      resetsAt: new Date("2026-06-06T14:00:00Z").toISOString(),
    });
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
