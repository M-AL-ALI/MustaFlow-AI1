import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  retireEmptyWorkspace,
  withProjectWorkspaceAdmission,
  WorkspaceAdmissionError,
  type WorkspaceTransaction,
} from "./workspace-lifecycle";

const enabled =
  process.env.NABUFLOW_VITEST_DATABASE_ENABLED === "true" &&
  Boolean(process.env.NABUFLOW_WORKSPACE_LIFECYCLE_FIXTURE_DATABASE);
const BARRIER = 178043219;
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function blockedBy(pid: number): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) LIMIT 1",
      [pid],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await delay(20);
  }
  throw new Error("Expected a PostgreSQL lock waiter, not just an elapsed delay");
}
async function insert(tx: WorkspaceTransaction) {
  return tx.execute(sql.raw("INSERT INTO projects(workspace_id) VALUES (301) RETURNING id"));
}

describe.skipIf(!enabled)("workspace lifecycle: isolated real PostgreSQL", () => {
  beforeAll(async () => {
    const identity = (
      await pool.query<{ database: string; host: string }>(
        "SELECT current_database() AS database, host(inet_server_addr()) AS host",
      )
    ).rows[0];
    if (
      identity?.host !== "127.0.0.1" ||
      !/^ora_gate_disposable_[a-f0-9]{16}$/.test(identity.database) ||
      identity.database !== process.env.NABUFLOW_WORKSPACE_LIFECYCLE_FIXTURE_DATABASE
    ) {
      throw new Error("Explicit disposable loopback fixture database required");
    }
    const occupied = (
      await pool.query(
        "SELECT to_regclass('public.workspaces') AS workspaces, to_regclass('public.projects') AS projects",
      )
    ).rows[0];
    if (occupied.workspaces || occupied.projects) throw new Error("Fixture database must be empty");
    await pool.query(
      "CREATE TABLE workspaces(id integer PRIMARY KEY, owner_user_id text NOT NULL, deleted_at timestamptz, updated_at timestamptz DEFAULT now());" +
        "CREATE TABLE workspace_members(workspace_id integer REFERENCES workspaces(id), user_id text, role text, PRIMARY KEY(workspace_id,user_id));" +
        "CREATE TABLE projects(id serial PRIMARY KEY, workspace_id integer REFERENCES workspaces(id), deleted_at timestamptz);" +
        "CREATE FUNCTION fixture_retirement_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(178043219); RETURN NEW; END $$;" +
        "CREATE TRIGGER fixture_retirement_barrier BEFORE UPDATE OF deleted_at ON workspaces FOR EACH ROW EXECUTE FUNCTION fixture_retirement_barrier();",
    );
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE projects, workspace_members, workspaces RESTART IDENTITY;" +
        "INSERT INTO workspaces(id,owner_user_id) VALUES(301,'owner-a'),(302,'owner-a'),(401,'owner-b');" +
        "INSERT INTO workspace_members VALUES(301,'owner-a','owner'),(302,'owner-a','owner'),(401,'owner-b','owner');",
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it.each(["owner", "admin", "builder"])(
    "admits a live %s membership in the exact destination",
    async (role) => {
      await pool.query("UPDATE workspace_members SET role=$1 WHERE workspace_id=301", [role]);
      await withProjectWorkspaceAdmission({ workspaceId: 301, userId: "owner-a" }, insert);
      expect((await pool.query("SELECT workspace_id FROM projects")).rows).toEqual([
        { workspace_id: 301 },
      ]);
    },
  );
  it.each(["viewer", "billing"])(
    "rejects %s without inserting into an owner fallback",
    async (role) => {
      await pool.query("UPDATE workspace_members SET role=$1 WHERE workspace_id=301", [role]);
      const callback = vi.fn(insert);
      await expect(
        withProjectWorkspaceAdmission({ workspaceId: 301, userId: "owner-a" }, callback),
      ).rejects.toBeInstanceOf(WorkspaceAdmissionError);
      expect(callback).not.toHaveBeenCalled();
      expect((await pool.query("SELECT id FROM projects")).rows).toEqual([]);
    },
  );
  it.each([401, 999])(
    "does not treat owner membership elsewhere as authority for workspace %s",
    async (workspaceId) => {
      const callback = vi.fn(insert);
      await expect(
        withProjectWorkspaceAdmission({ workspaceId, userId: "owner-a" }, callback),
      ).rejects.toBeInstanceOf(WorkspaceAdmissionError);
      expect(callback).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER])(
    "rejects invalid destination %s before invoking the writer",
    async (workspaceId) => {
      const callback = vi.fn(insert);
      await expect(
        withProjectWorkspaceAdmission({ workspaceId, userId: "owner-a" }, callback),
      ).rejects.toBeInstanceOf(WorkspaceAdmissionError);
      expect(callback).not.toHaveBeenCalled();
    },
  );
  it("holds the destination until creation commits, then refuses retirement", async () => {
    const entered = latch();
    const release = latch();
    let writerPid = 0;
    const creation = withProjectWorkspaceAdmission(
      { workspaceId: 301, userId: "owner-a" },
      async (tx) => {
        writerPid = Number(
          (await tx.execute(sql.raw("SELECT pg_backend_pid() AS pid"))).rows[0].pid,
        );
        entered.resolve();
        await release.promise;
        return insert(tx);
      },
    );
    await entered.promise;
    const retirement = retireEmptyWorkspace({ workspaceId: 301, userId: "owner-a" });
    try {
      expect(await blockedBy(writerPid)).toBeGreaterThan(0);
    } finally {
      release.resolve();
    }
    await creation;
    await expect(retirement).resolves.toBe("projects-remain");
    expect(
      (await pool.query("SELECT deleted_at FROM workspaces WHERE id=301")).rows[0].deleted_at,
    ).toBeNull();
  });
  it("waits for an actual in-flight retirement, then denies creation without side effects", async () => {
    const barrier = await pool.connect();
    const pid = Number((await barrier.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await barrier.query("SELECT pg_advisory_lock($1)", [BARRIER]);
    const retirement = retireEmptyWorkspace({ workspaceId: 301, userId: "owner-a" });
    let creation: Promise<unknown> | undefined;
    const callback = vi.fn(insert);
    try {
      const retirementPid = await blockedBy(pid);
      creation = withProjectWorkspaceAdmission(
        { workspaceId: 301, userId: "owner-a" },
        callback,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(await blockedBy(retirementPid)).toBeGreaterThan(0);
    } finally {
      await barrier.query("SELECT pg_advisory_unlock($1)", [BARRIER]);
      barrier.release();
    }
    await expect(retirement).resolves.toBe("retired");
    expect(await creation).toBeInstanceOf(WorkspaceAdmissionError);
    expect(callback).not.toHaveBeenCalled();
    expect((await pool.query("SELECT id FROM projects")).rows).toEqual([]);
  });
  it("rechecks a role demotion that wins the membership lock", async () => {
    const revoker = await pool.connect();
    await revoker.query("BEGIN");
    const pid = Number((await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await revoker.query(
      "UPDATE workspace_members SET role='viewer' WHERE workspace_id=301 AND user_id='owner-a'",
    );
    const callback = vi.fn(insert);
    const creation = withProjectWorkspaceAdmission(
      { workspaceId: 301, userId: "owner-a" },
      callback,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      expect(await blockedBy(pid)).toBeGreaterThan(0);
    } finally {
      await revoker.query("COMMIT");
      revoker.release();
    }
    expect(await creation).toBeInstanceOf(WorkspaceAdmissionError);
    expect(callback).not.toHaveBeenCalled();
  });
  it("rolls back a failed insertion and releases the workspace for a legitimate retirement", async () => {
    await expect(
      withProjectWorkspaceAdmission({ workspaceId: 301, userId: "owner-a" }, async (tx) => {
        await insert(tx);
        throw new Error("fixture-insertion-failure");
      }),
    ).rejects.toThrow("fixture-insertion-failure");
    expect((await pool.query("SELECT id FROM projects")).rows).toEqual([]);
    await expect(retireEmptyWorkspace({ workspaceId: 301, userId: "owner-a" })).resolves.toBe(
      "retired",
    );
  });
  it.each([null, "2026-09-01T00:00:00Z"])(
    "retains workspace references for active or Trash projects (%s)",
    async (deletedAt) => {
      await pool.query("INSERT INTO projects(workspace_id,deleted_at) VALUES(301,$1)", [deletedAt]);
      await expect(retireEmptyWorkspace({ workspaceId: 301, userId: "owner-a" })).resolves.toBe(
        "projects-remain",
      );
    },
  );
  it("cannot retire both of the owner's last two workspaces concurrently", async () => {
    const first = retireEmptyWorkspace({ workspaceId: 301, userId: "owner-a" });
    const second = retireEmptyWorkspace({ workspaceId: 302, userId: "owner-a" });
    expect([await first, await second].sort()).toEqual(["only-workspace", "retired"]);
    expect(
      (
        await pool.query(
          "SELECT id FROM workspaces WHERE owner_user_id='owner-a' AND deleted_at IS NULL",
        )
      ).rowCount,
    ).toBe(1);
  });
  it("uses the same non-revealing result for a foreign and missing workspace", async () => {
    await expect(retireEmptyWorkspace({ workspaceId: 401, userId: "owner-a" })).resolves.toBe(
      "not-found",
    );
    await expect(retireEmptyWorkspace({ workspaceId: 999, userId: "owner-a" })).resolves.toBe(
      "not-found",
    );
  });
});
