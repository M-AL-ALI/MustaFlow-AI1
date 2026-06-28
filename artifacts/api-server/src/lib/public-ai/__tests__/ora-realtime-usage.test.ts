/**
 * Ora LIVE-VOICE ("Talk to Ora") minute-budget metering — service unit tests.
 *
 * Exercises ora-realtime-usage.ts directly against the REAL Postgres dev DB (the
 * established pattern for the realtime suite — each test uses a UNIQUE random
 * usage key so there is no cross-test collision and no shared cleanup race).
 * Time-dependent paths (charge-on-heartbeat, stale finalize, client-duration
 * clamping) are made deterministic by inserting session rows with controlled
 * startedAt / lastHeartbeatAt timestamps instead of sleeping.
 *
 * Covers:
 *  - per-tier allowances (free 1200s/5h, core 3600s/3h, wave 7200s/3h; anon→free)
 *  - fresh / seeded / elapsed-window usage projection
 *  - start: ok (cap = min(remaining, per-session cap)), over_limit, concurrent
 *  - heartbeat: charges elapsed delta, never double-charges, ends at the cap
 *  - end: clamps an inflated client duration, never refunds, idempotent
 *  - stale sweep: finalizes at lastHeartbeat + grace, marks 'expired'
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, oraRealtimeUsageWindowsTable, oraRealtimeSessionsTable } from "@workspace/db";
import {
  getRealtimeVoiceAllowance,
  getRealtimeUsage,
  startRealtimeSession,
  heartbeatRealtimeSession,
  endRealtimeSession,
  sweepStaleRealtimeSessions,
} from "../ora-realtime-usage";

// Every key created here is unique + namespaced so the afterAll sweep only ever
// deletes this file's own rows.
const createdKeys: string[] = [];

function uniqueKey(label: string): string {
  const key = `test:realtime:${label}:${randomUUID()}`;
  createdKeys.push(key);
  return key;
}

async function seedWindow(usageKey: string, usedSeconds: number, windowStart = new Date()) {
  await db.insert(oraRealtimeUsageWindowsTable).values({ usageKey, usedSeconds, windowStart });
}

async function insertSession(opts: {
  usageKey: string;
  tier: string;
  maxDurationSeconds: number;
  startedAtMsAgo?: number;
  lastHeartbeatMsAgo?: number;
  chargedSeconds?: number;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.insert(oraRealtimeSessionsTable).values({
    id,
    usageKey: opts.usageKey,
    tier: opts.tier,
    maxDurationSeconds: opts.maxDurationSeconds,
    chargedSeconds: opts.chargedSeconds ?? 0,
    status: opts.status ?? "active",
    startedAt: new Date(now - (opts.startedAtMsAgo ?? 0)),
    lastHeartbeatAt: new Date(now - (opts.lastHeartbeatMsAgo ?? 0)),
  });
  return id;
}

afterAll(async () => {
  if (createdKeys.length === 0) return;
  await db
    .delete(oraRealtimeSessionsTable)
    .where(inArray(oraRealtimeSessionsTable.usageKey, createdKeys));
  await db
    .delete(oraRealtimeUsageWindowsTable)
    .where(inArray(oraRealtimeUsageWindowsTable.usageKey, createdKeys));
});

describe("getRealtimeVoiceAllowance", () => {
  it("free = 1200s / 5h window / 1200s per-session cap (full allowance)", () => {
    expect(getRealtimeVoiceAllowance("free")).toEqual({
      tier: "free",
      limitSeconds: 1200,
      windowHours: 5,
      sessionCapSeconds: 1200,
    });
  });

  it("core = 3600s / 3h window / 3600s per-session cap (full allowance)", () => {
    expect(getRealtimeVoiceAllowance("core")).toEqual({
      tier: "core",
      limitSeconds: 3600,
      windowHours: 3,
      sessionCapSeconds: 3600,
    });
  });

  it("wave = 7200s / 3h window / 7200s per-session cap (full allowance)", () => {
    expect(getRealtimeVoiceAllowance("wave")).toEqual({
      tier: "wave",
      limitSeconds: 7200,
      windowHours: 3,
      sessionCapSeconds: 7200,
    });
  });

  it("anonymous / unknown tiers fall back to the free allowance", () => {
    const free = getRealtimeVoiceAllowance("free");
    expect(getRealtimeVoiceAllowance("anonymous")).toEqual(free);
    expect(getRealtimeVoiceAllowance("not-a-tier")).toEqual(free);
  });
});

describe("getRealtimeUsage", () => {
  it("a fresh key reports full remaining, zero used, and no active window", async () => {
    const key = uniqueKey("fresh");
    const snap = await getRealtimeUsage(key, "free");
    expect(snap.usedSeconds).toBe(0);
    expect(snap.limitSeconds).toBe(1200);
    expect(snap.remainingSeconds).toBe(1200);
    expect(snap.windowStart).toBeNull();
    expect(snap.resetsAt).toBeNull();
  });

  it("reflects seeded usage and computes resetsAt inside the active window", async () => {
    const key = uniqueKey("seeded");
    await seedWindow(key, 200);
    const snap = await getRealtimeUsage(key, "core");
    expect(snap.usedSeconds).toBe(200);
    expect(snap.limitSeconds).toBe(3600);
    expect(snap.remainingSeconds).toBe(3400);
    expect(snap.windowStart).not.toBeNull();
    expect(snap.resetsAt).not.toBeNull();
  });

  it("treats an elapsed window as fully reset on read (no write)", async () => {
    const key = uniqueKey("elapsed");
    // free window is 5h; opening it 6h ago means it has already refilled.
    await seedWindow(key, 900, new Date(Date.now() - 6 * 3_600_000));
    const snap = await getRealtimeUsage(key, "free");
    expect(snap.usedSeconds).toBe(0);
    expect(snap.remainingSeconds).toBe(1200);
    expect(snap.resetsAt).toBeNull();
  });
});

describe("startRealtimeSession", () => {
  it("ok: reserves a session for the full remaining allowance when budget is ample", async () => {
    const key = uniqueKey("start-ok");
    const res = await startRealtimeSession(key, "wave");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.remainingSeconds).toBe(7200);
    expect(res.limitSeconds).toBe(7200);
    // wave per-session cap (7200) == remaining (7200): full allowance available
    expect(res.maxDurationSeconds).toBe(7200);
    expect(res.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.resetsAt).toBeNull();
  });

  it("ok: caps maxDurationSeconds to the remaining budget when it is below the per-session cap", async () => {
    const key = uniqueKey("start-low");
    // free limit 1200, used 1150 -> remaining 50 < per-session cap 1200
    await seedWindow(key, 1150);
    const res = await startRealtimeSession(key, "free");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.remainingSeconds).toBe(50);
    expect(res.maxDurationSeconds).toBe(50);
  });

  it("over_limit: a fully-used window blocks a new session and reports resetsAt", async () => {
    const key = uniqueKey("over");
    await seedWindow(key, 1200); // free, fully exhausted
    const res = await startRealtimeSession(key, "free");
    expect(res.status).toBe("over_limit");
    expect(res.remainingSeconds).toBe(0);
    expect(res.limitSeconds).toBe(1200);
    expect(res.resetsAt).not.toBeNull();
  });

  it("concurrent: a second active session for the same key is blocked", async () => {
    const key = uniqueKey("concurrent");
    const first = await startRealtimeSession(key, "core");
    expect(first.status).toBe("ok");
    const second = await startRealtimeSession(key, "core");
    expect(second.status).toBe("concurrent");
    if (second.status !== "concurrent") throw new Error("expected concurrent");
    expect(second.limitSeconds).toBe(3600);
  });

  it("concurrent (race): two PARALLEL starts for one key mint exactly one session", async () => {
    const key = uniqueKey("concurrent-race");
    // Fire both starts at once. The per-usageKey advisory lock must serialize
    // them so exactly one wins "ok" and the other sees the now-active session.
    // Without the lock both could observe "no active session" and both insert.
    const [a, b] = await Promise.all([
      startRealtimeSession(key, "core"),
      startRealtimeSession(key, "core"),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["concurrent", "ok"]);
    // And the table proves it: only ONE active row exists for the key.
    const active = await db
      .select({ id: oraRealtimeSessionsTable.id })
      .from(oraRealtimeSessionsTable)
      .where(eq(oraRealtimeSessionsTable.usageKey, key));
    expect(active.length).toBe(1);
  });
});

describe("heartbeatRealtimeSession", () => {
  it("charges the elapsed-but-uncharged delta and decreases remaining", async () => {
    const key = uniqueKey("hb");
    const id = await insertSession({
      usageKey: key,
      tier: "free",
      maxDurationSeconds: 300,
      startedAtMsAgo: 100_000,
    });
    const res = await heartbeatRealtimeSession(id, key, "free");
    expect(res.status).toBe("active");
    if (res.status === "not_found") throw new Error("expected a tick result");
    expect(res.chargedSeconds).toBeGreaterThanOrEqual(100);
    expect(res.chargedSeconds).toBeLessThanOrEqual(103);
    expect(res.remainingSeconds).toBe(1200 - res.chargedSeconds);
    expect(res.ended).toBe(false);
  });

  it("a repeated heartbeat never double-charges the window", async () => {
    const key = uniqueKey("hb-double");
    const id = await insertSession({
      usageKey: key,
      tier: "free",
      maxDurationSeconds: 300,
      startedAtMsAgo: 60_000,
    });
    const first = await heartbeatRealtimeSession(id, key, "free");
    const second = await heartbeatRealtimeSession(id, key, "free");
    if (first.status === "not_found" || second.status === "not_found") {
      throw new Error("expected tick results");
    }
    // Window total tracks elapsed (~60s), NOT the sum of both beats (~120s).
    const usage = await getRealtimeUsage(key, "free");
    expect(usage.usedSeconds).toBeGreaterThanOrEqual(60);
    expect(usage.usedSeconds).toBeLessThanOrEqual(63);
    // charged advances monotonically with the server clock; it is never summed.
    expect(second.chargedSeconds).toBeGreaterThanOrEqual(first.chargedSeconds);
  });

  it("marks the session ended once elapsed reaches the per-session cap", async () => {
    const key = uniqueKey("hb-cap");
    // started 400s ago against a 300s cap -> capped, ended.
    const id = await insertSession({
      usageKey: key,
      tier: "free",
      maxDurationSeconds: 300,
      startedAtMsAgo: 400_000,
    });
    const res = await heartbeatRealtimeSession(id, key, "free");
    if (res.status === "not_found") throw new Error("expected a tick result");
    expect(res.ended).toBe(true);
    expect(res.status).toBe("ended");
    expect(res.chargedSeconds).toBe(300);
    expect(res.remainingSeconds).toBe(1200 - 300);
  });

  it("returns not_found for an unknown session id or a usage-key mismatch", async () => {
    const key = uniqueKey("hb-nf");
    const unknown = await heartbeatRealtimeSession(randomUUID(), key, "free");
    expect(unknown.status).toBe("not_found");
    const id = await insertSession({ usageKey: key, tier: "free", maxDurationSeconds: 300 });
    const mismatch = await heartbeatRealtimeSession(id, uniqueKey("hb-other"), "free");
    expect(mismatch.status).toBe("not_found");
  });
});

describe("endRealtimeSession", () => {
  it("clamps an inflated client duration down to the server-elapsed time", async () => {
    const key = uniqueKey("end-inflate");
    const id = await insertSession({
      usageKey: key,
      tier: "core",
      maxDurationSeconds: 600,
      startedAtMsAgo: 50_000,
    });
    const res = await endRealtimeSession(id, key, "core", 999_999);
    if (res.status === "not_found") throw new Error("expected a tick result");
    expect(res.status).toBe("ended");
    expect(res.chargedSeconds).toBeGreaterThanOrEqual(50);
    expect(res.chargedSeconds).toBeLessThanOrEqual(53);
    expect(res.remainingSeconds).toBe(3600 - res.chargedSeconds);
  });

  it("never refunds below seconds already charged", async () => {
    const key = uniqueKey("end-refund");
    // already charged 40s; client now claims 0.
    const id = await insertSession({
      usageKey: key,
      tier: "core",
      maxDurationSeconds: 600,
      startedAtMsAgo: 50_000,
      chargedSeconds: 40,
    });
    await seedWindow(key, 40);
    const res = await endRealtimeSession(id, key, "core", 0);
    if (res.status === "not_found") throw new Error("expected a tick result");
    expect(res.chargedSeconds).toBe(40);
    const usage = await getRealtimeUsage(key, "core");
    expect(usage.usedSeconds).toBe(40);
  });

  it("is idempotent — re-ending returns the snapshot without an extra charge", async () => {
    const key = uniqueKey("end-idem");
    const id = await insertSession({
      usageKey: key,
      tier: "free",
      maxDurationSeconds: 300,
      startedAtMsAgo: 30_000,
    });
    const first = await endRealtimeSession(id, key, "free");
    if (first.status === "not_found") throw new Error("expected a tick result");
    const firstCharged = first.chargedSeconds;
    const second = await endRealtimeSession(id, key, "free", 999_999);
    if (second.status === "not_found") throw new Error("expected a tick result");
    expect(second.ended).toBe(true);
    expect(second.chargedSeconds).toBe(firstCharged);
    const usage = await getRealtimeUsage(key, "free");
    expect(usage.usedSeconds).toBe(firstCharged);
  });

  it("returns not_found for an unknown session id", async () => {
    const res = await endRealtimeSession(randomUUID(), uniqueKey("end-nf"), "free");
    expect(res.status).toBe("not_found");
  });
});

describe("sweepStaleRealtimeSessions", () => {
  it("finalizes a stale session at lastHeartbeat + grace and marks it 'expired'", async () => {
    const key = uniqueKey("stale");
    // started 200s ago, last heartbeat 120s ago (> 60s grace) -> stale.
    // Finalized elapsed = (200 - 120 + 60) = 140s, under the 300s cap.
    const id = await insertSession({
      usageKey: key,
      tier: "free",
      maxDurationSeconds: 300,
      startedAtMsAgo: 200_000,
      lastHeartbeatMsAgo: 120_000,
    });
    const count = await sweepStaleRealtimeSessions();
    expect(typeof count).toBe("number");
    const [row] = await db
      .select()
      .from(oraRealtimeSessionsTable)
      .where(eq(oraRealtimeSessionsTable.id, id));
    expect(row.status).toBe("expired");
    expect(row.chargedSeconds).toBe(140);
    const usage = await getRealtimeUsage(key, "free");
    expect(usage.usedSeconds).toBe(140);
  });
});
