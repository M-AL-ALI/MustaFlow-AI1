import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

import {
  reserveDualWindowAdmission,
  type AdmissionConnectionFactory,
} from "./brainstorm-admission-store";

const clock = {
  server_now: new Date("2026-08-19T13:59:59.000Z"),
  hour_start: new Date("2026-08-19T13:00:00.000Z"),
  hour_reset: new Date("2026-08-19T14:00:00.000Z"),
  day_start: new Date("2026-08-19T00:00:00.000Z"),
  day_reset: new Date("2026-08-20T00:00:00.000Z"),
};

function fakeConnection(counts: { hour: number; day: number }, failAt?: string) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const release = vi.fn();
  const query = vi.fn(async (statement: string, values?: unknown[]) => {
    const sql = statement.replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (failAt && sql.includes(failAt)) throw new Error("database unavailable");
    if (sql.startsWith("SELECT transaction_timestamp")) return { rows: [clock], rowCount: 1 };
    if (sql.startsWith("SELECT count")) {
      const kind = values?.[1] as "hour" | "day";
      return { rows: [{ count: counts[kind] }], rowCount: 1 };
    }
    return { rows: [], rowCount: sql.startsWith("DELETE") ? 0 : 1 };
  });
  const connect: AdmissionConnectionFactory = async () => ({ query, release }) as never;
  return { calls, connect, query, release };
}

const input = {
  key: "brainstorm_admission:v1:account:digest",
  hourlyLimit: 60,
  dailyLimit: 200,
  weight: 1,
};

describe("Postgres dual-window brainstorm admission", () => {
  it("locks hour and day rows in deterministic key order and advances both", async () => {
    const fake = fakeConnection({ hour: 58, day: 198 });

    await expect(reserveDualWindowAdmission(input, fake.connect)).resolves.toEqual({
      allowed: true,
      blockedWindow: null,
      hourCount: 59,
      dayCount: 199,
      hourResetAtMs: clock.hour_reset.getTime(),
      dayResetAtMs: clock.day_reset.getTime(),
      serverNowMs: clock.server_now.getTime(),
    });

    const inserts = fake.calls.filter((call) => call.sql.startsWith("INSERT INTO"));
    const locks = fake.calls.filter((call) => call.sql.startsWith("SELECT count"));
    const updates = fake.calls.filter((call) => call.sql.startsWith("UPDATE"));
    expect(inserts.map((call) => call.values?.[1])).toEqual(["day", "hour"]);
    expect(locks.map((call) => call.values?.[1])).toEqual(["day", "hour"]);
    expect(updates.map((call) => call.values?.[1])).toEqual(["day", "hour"]);
    expect(fake.calls.at(0)?.sql).toBe("BEGIN");
    expect(fake.calls[1]?.sql).toContain("AT TIME ZONE 'UTC'");
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT");
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("rejects the day window without incrementing either row", async () => {
    const fake = fakeConnection({ hour: 59, day: 200 });

    await expect(reserveDualWindowAdmission(input, fake.connect)).resolves.toMatchObject({
      allowed: false,
      blockedWindow: "day",
      hourCount: 59,
      dayCount: 200,
    });

    expect(fake.calls.filter((call) => call.sql.startsWith("UPDATE"))).toHaveLength(0);
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("reserves resolve weight two atomically", async () => {
    const fake = fakeConnection({ hour: 57, day: 197 });

    await expect(
      reserveDualWindowAdmission({ ...input, weight: 2 }, fake.connect),
    ).resolves.toMatchObject({ hourCount: 59, dayCount: 199 });

    const updates = fake.calls.filter((call) => call.sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(2);
    expect(updates.every((call) => call.values?.[3] === 2)).toBe(true);
  });

  it("returns retry timing from the same database clock that owns the buckets", async () => {
    const fake = fakeConnection({ hour: 60, day: 100 });

    const result = await reserveDualWindowAdmission(input, fake.connect);

    expect(result).toMatchObject({
      allowed: false,
      blockedWindow: "hour",
      hourResetAtMs: Date.parse("2026-08-19T14:00:00.000Z"),
      dayResetAtMs: Date.parse("2026-08-20T00:00:00.000Z"),
      serverNowMs: Date.parse("2026-08-19T13:59:59.000Z"),
    });
  });

  it("rolls back and releases the client on any transaction failure", async () => {
    const fake = fakeConnection({ hour: 1, day: 1 }, "SELECT count");

    await expect(reserveDualWindowAdmission(input, fake.connect)).rejects.toThrow(
      "database unavailable",
    );

    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.calls.some((call) => call.sql.startsWith("UPDATE"))).toBe(false);
  });

  it("rejects invalid limits before opening a database connection", async () => {
    const connect = vi.fn();

    await expect(reserveDualWindowAdmission({ ...input, hourlyLimit: 0 }, connect)).rejects.toThrow(
      "Invalid hourly admission limit",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("prunes expired buckets through the indexed retention boundary", async () => {
    const fake = fakeConnection({ hour: 1, day: 1 });

    await reserveDualWindowAdmission(input, fake.connect);

    const cleanup = fake.calls.find((call) => call.sql.startsWith("DELETE FROM"));
    expect(cleanup?.sql).toContain("reset_at < $1::timestamptz - interval '1 day'");
    expect(cleanup?.values).toEqual([clock.day_start]);
  });
});
