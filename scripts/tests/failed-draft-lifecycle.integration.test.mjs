/* global process, URL, Buffer, AbortController, setTimeout, clearTimeout, console */
// Run with the existing workspace TS runner:
// pnpm --filter @workspace/scripts exec tsx --test tests/failed-draft-lifecycle.integration.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

// Explicit opt-in: never borrow DATABASE_URL or contact production.
const connectionString = process.env.JRN77_TEST_DATABASE_URL;
const root = new URL("../../", import.meta.url);
const requireDb = createRequire(new URL("lib/db/package.json", root));
const requireRoot = createRequire(new URL("package.json", root));
const requireApi = createRequire(new URL("artifacts/api-server/package.json", root));
const tenantContracts = requireApi("@workspace/tenant-runtime-contracts");
const oraContracts = requireApi("@workspace/ora-contracts");
const express = requireApi("express");
const request = requireApi("supertest");
const ts = requireRoot("typescript");
const { Pool, Client } = requireDb("pg");
const orm = requireDb("drizzle-orm");
const { drizzle } = requireDb("drizzle-orm/node-postgres");
const { pgTable, integer, serial, text, timestamp, boolean, jsonb, getTableConfig } =
  requireDb("drizzle-orm/pg-core");

function compile(source, filename, imports = {}, globals = {}) {
  const module = { exports: {} };
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: filename,
  }).outputText;
  runInNewContext(
    output,
    {
      module,
      exports: module.exports,
      Buffer,
      URL,
      AbortController,
      setTimeout,
      clearTimeout,
      console,
      ...globals,
      require(name) {
        if (Object.hasOwn(imports, name)) return imports[name];
        if (name.startsWith("node:")) return requireRoot(name);
        if (name === "@workspace/tenant-runtime-contracts") return tenantContracts;
        throw new Error("Unexpected integration dependency: " + name);
      },
    },
    { filename },
  );
  return module.exports;
}
function sourceModule(relative, imports = {}) {
  const file = new URL(relative, root);
  return compile(readFileSync(file, "utf8"), fileURLToPath(file), imports);
}
const sourceByPath = new Map();
function source(relative) {
  if (!sourceByPath.has(relative))
    sourceByPath.set(relative, readFileSync(new URL(relative, root), "utf8"));
  return sourceByPath.get(relative);
}
const q = (name) => {
  assert.match(name, /^[a-z][a-z0-9_]*$/);
  return '"' + name + '"';
};

function disposableConnectionOptions(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "59103");
  assert.equal(url.pathname, "/ora_gate_disposable_c84abf01fb72451b");
  assert.equal(url.username, "nabuflow_lab");
  assert.equal(url.search, "", "Connection query overrides are forbidden");
  assert.equal(url.hash, "", "Connection fragments are forbidden");
  return {
    host: "127.0.0.1",
    port: 59103,
    database: "ora_gate_disposable_c84abf01fb72451b",
    user: "nabuflow_lab",
    // A callback prevents implicit PGPASSWORD/pgpass fallback for this opt-in fixture.
    password: () => decodeURIComponent(url.password),
    ssl: false,
    options: "-c search_path=pg_catalog",
    application_name: "jrn77-disposable-lifecycle",
  };
}

async function assertDisposableSession(client, schema) {
  const identity = await client.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS host, " +
      "inet_server_port() AS port, current_user AS role, current_schema() AS schema, " +
      "current_setting('search_path') AS search_path",
  );
  assert.deepEqual(identity.rows[0], {
    name: "ora_gate_disposable_c84abf01fb72451b",
    host: "127.0.0.1",
    port: 59103,
    role: "nabuflow_lab",
    schema,
    search_path: schema,
  });
}

const disposableUrl =
  "postgresql://nabuflow_lab@127.0.0.1:59103/ora_gate_disposable_c84abf01fb72451b";
for (const [label, value] of [
  ["host query override", disposableUrl + "?host=elsewhere.invalid"],
  ["database query override", disposableUrl + "?database=other"],
  ["schema query override", disposableUrl + "?options=-c%20search_path%3Dpublic"],
  ["encoded query override", disposableUrl + "?%68ost=elsewhere.invalid"],
  ["fragment", disposableUrl + "#ignored"],
  ["remote host", disposableUrl.replace("127.0.0.1", "elsewhere.invalid")],
  ["hostname alias", disposableUrl.replace("127.0.0.1", "localhost")],
  ["different port", disposableUrl.replace(":59103/", ":5432/")],
  ["implicit port", disposableUrl.replace(":59103/", "/")],
  ["different database", disposableUrl.replace("ora_gate_disposable_c84abf01fb72451b", "other")],
  ["different role", disposableUrl.replace("nabuflow_lab@", "other@")],
]) {
  test("disposable lifecycle harness rejects " + label + " before connection", () => {
    assert.throws(() => disposableConnectionOptions(value));
  });
}

test("disposable lifecycle harness supplies explicit effective driver target and schema options", () => {
  const options = disposableConnectionOptions(disposableUrl);
  assert.equal(Object.hasOwn(options, "connectionString"), false);
  const parameters = new Client({ ...options, options: "-c search_path=jrn77_lock_fixture" })
    .connectionParameters;
  assert.equal(parameters.host, "127.0.0.1");
  assert.equal(parameters.port, 59103);
  assert.equal(parameters.database, "ora_gate_disposable_c84abf01fb72451b");
  assert.equal(parameters.user, "nabuflow_lab");
  assert.equal(parameters.options, "-c search_path=jrn77_lock_fixture");
  assert.equal(parameters.ssl, false);
  assert.equal(options.password(), "");
});

test(
  "failed-draft retry and file-save transactions use genuine lifecycle ownership",
  { skip: !connectionString, timeout: 45000 },
  async (t) => {
    const connection = disposableConnectionOptions(connectionString);
    const schema = "jrn77_lock_" + randomUUID().replaceAll("-", "");
    const admin = new Pool({ ...connection, max: 2, connectionTimeoutMillis: 2000 });
    let pool;
    let probe;
    let schemaCreated = false;
    const responses = [];
    try {
      await assertDisposableSession(admin, "pg_catalog");
      await admin.query("CREATE SCHEMA " + q(schema));
      schemaCreated = true;
      pool = new Pool({
        ...connection,
        max: 6,
        options: "-c search_path=" + schema,
        connectionTimeoutMillis: 2000,
        statement_timeout: 6000,
      });
      await assertDisposableSession(pool, schema);
      probe = await admin.connect();
      const projectsTable = pgTable("projects", {
        id: integer("id").primaryKey(),
        ownerId: text("owner_id"),
        deletedAt: timestamp("deleted_at"),
      });
      const agentTasksTable = pgTable("agent_tasks", {
        id: serial("id").primaryKey(),
        projectId: integer("project_id"),
        status: text("status"),
        prompt: text("prompt"),
        report: jsonb("report"),
        stagingSnapshot: jsonb("staging_snapshot"),
        origin: text("origin"),
        provenanceActorUserId: text("provenance_actor_user_id"),
        supportSessionId: integer("support_session_id"),
        agentIdentity: text("agent_identity"),
        title: text("title"),
        kind: text("kind"),
        attachments: jsonb("attachments"),
        runMode: text("run_mode"),
        wallClockCapMs: integer("wall_clock_cap_ms"),
        creditsReserved: integer("credits_reserved"),
        intentReceiptId: integer("intent_receipt_id"),
        terminal: jsonb("terminal"),
        taskAgentMode: text("task_agent_mode"),
        deepReasoning: boolean("deep_reasoning"),
        hasBrainstormContext: boolean("has_brainstorm_context"),
        brainstormTurnCount: integer("brainstorm_turn_count"),
      });
      const projectArtifactsTable = pgTable("project_artifacts", {
        id: integer("id").primaryKey(),
        projectId: integer("project_id"),
        isPrimary: boolean("is_primary"),
        deletedAt: timestamp("deleted_at"),
      });
      const projectFilesTable = pgTable("project_files", {
        id: serial("id").primaryKey(),
        projectId: integer("project_id"),
        artifactId: integer("artifact_id"),
        path: text("path"),
        content: text("content"),
        mimeType: text("mime_type"),
      });
      const projectVersionsTable = pgTable("project_versions", {
        id: serial("id").primaryKey(),
        projectId: integer("project_id"),
        filesSnapshot: jsonb("files_snapshot"),
      });
      const usages = pgTable("test_asset_usage", {
        id: serial("id").primaryKey(),
        projectId: integer("project_id"),
        filePath: text("file_path"),
        content: text("content"),
      });
      const tables = {
        projectsTable,
        agentTasksTable,
        projectArtifactsTable,
        projectFilesTable,
        projectVersionsTable,
      };
      for (const table of [...Object.values(tables), usages]) {
        const config = getTableConfig(table);
        await pool.query(
          "CREATE TABLE " +
            q(config.name) +
            " (" +
            config.columns
              .map((c) => q(c.name) + " " + c.getSQLType() + (c.primary ? " PRIMARY KEY" : ""))
              .join(", ") +
            ")",
        );
      }
      const db = drizzle(pool);
      const dbModule = { db, pool, ...tables };
      const contract = sourceModule("artifacts/api-server/src/lib/project-retirement-contract.ts");
      const namespace = contract.PROJECT_LIFECYCLE_LOCK_NAMESPACE;
      assert.equal(namespace, 1312967234);
      const lifecycle = sourceModule("artifacts/api-server/src/lib/project-lifecycle.ts", {
        "drizzle-orm": orm,
        "@workspace/db": dbModule,
        "./project-retirement-contract": contract,
        "./auth": {
          checkProjectAccess() {
            throw new Error("Unexpected auth call in internal lock test");
          },
        },
        "./support-access": {
          findLiveSupportGrant() {
            throw new Error("Unexpected support call");
          },
        },
      });
      const draft = sourceModule("artifacts/api-server/src/lib/zero-sealed-failed-draft.ts");
      const primary = sourceModule("artifacts/api-server/src/lib/primary-artifact-files.ts", {
        "@workspace/db": dbModule,
        "drizzle-orm": orm,
      });
      let failReconciliation = false;
      const writer = sourceModule("artifacts/api-server/src/lib/project-file-writer.ts", {
        "drizzle-orm": orm,
        "@workspace/db": dbModule,
        "./primary-artifact-files": primary,
        "./zero-sealed-failed-draft": draft,
        "./project-retirement-contract": contract,
        "./project-lifecycle": lifecycle,
        "./artifacts": {
          async resolveArtifactId() {
            return 7;
          },
        },
        "./project-file-asset-usage": {
          async reconcileProjectFileAssetUsage(tx, input) {
            await tx.insert(usages).values({
              projectId: input.projectId,
              filePath: input.filePath,
              content: input.nextContent,
            });
            if (failReconciliation) throw new Error("synthetic reference failure");
          },
        },
      });
      const projectId = 777777;
      const owner = "jrn77-lab-owner";
      const baseFiles = [
        { path: "src/index.ts", content: "original", mimeType: "text/typescript" },
      ];
      const fingerprint = draft.failedDraftFingerprint(baseFiles);
      const originalRequest =
        "Build the complete English and Arabic team notebook with persisted notes and a settings page. Preserve every requirement, not only the shortened history title.";
      const retryBinding = { taskId: 320, actorUserId: owner, baseFingerprint: fingerprint };
      const route = source("artifacts/api-server/src/routes/messages.ts");
      const start = route.indexOf("const createTask = async");
      const end = route.indexOf("task = retryBinding", start);
      assert.ok(start >= 0 && end > start, "retry transaction extraction anchors exist");
      function createTask() {
        return compile(
          route.slice(start, end) + "\nexports.createTask = createTask;",
          "messages.retry-transaction.ts",
          {},
          {
            db,
            ...tables,
            ...orm,
            ...lifecycle,
            ...draft,
            PROJECT_LIFECYCLE_LOCK_NAMESPACE: namespace,
            retryBinding,
            project: { id: projectId },
            req: { userId: owner },
            currentProjectFiles: baseFiles,
            content: originalRequest,
            kind: "refine",
            runInBackground: false,
            hasActiveTask: false,
            persistedAttachments: [],
            resolvedAgentIdentity: "main",
            messageOrigin: null,
            wallClockCapMs: null,
            mode: "power",
            deepReasoning: false,
            hasBrainstormContext: false,
            supportMutation: undefined,
          },
        ).createTask;
      }
      async function reset() {
        failReconciliation = false;
        await pool.query(
          "TRUNCATE " +
            Object.values(tables)
              .map((table) => q(getTableConfig(table).name))
              .concat(q("test_asset_usage"))
              .join(", ") +
            " RESTART IDENTITY",
        );
        await db.insert(projectsTable).values({ id: projectId, ownerId: owner });
        await db.insert(projectArtifactsTable).values({ id: 7, projectId, isPrimary: true });
        await db
          .insert(projectFilesTable)
          .values(baseFiles.map((file) => ({ ...file, projectId, artifactId: 7 })));
        await db.insert(agentTasksTable).values({
          id: 320,
          projectId,
          status: "failed",
          prompt: originalRequest,
          provenanceActorUserId: owner,
        });
      }
      async function admit() {
        const res = Object.assign(new EventEmitter(), {
          locals: {},
          destroyed: false,
          writableEnded: false,
          status() {
            return this;
          },
          json(value) {
            throw new Error("Unexpected admission response: " + JSON.stringify(value));
          },
        });
        responses.push(res);
        let admitted = false;
        await lifecycle.requireActiveProjectLifecycleSession(
          { params: { id: String(projectId) } },
          res,
          () => {
            admitted = true;
          },
        );
        assert.equal(admitted, true);
        return res;
      }
      async function canLock() {
        const result = await probe.query(
          "SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired",
          [namespace, projectId],
        );
        if (result.rows[0].acquired)
          await probe.query("SELECT pg_advisory_unlock($1::integer,$2::integer)", [
            namespace,
            projectId,
          ]);
        return result.rows[0].acquired;
      }
      async function finish(res) {
        res.writableEnded = true;
        res.emit("finish");
        for (let i = 0; i < 30; i++) {
          if (await canLock()) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail("admitted lock was not released");
      }
      const input = (extra = {}) => ({
        projectId,
        scope: { kind: "artifact" },
        files: [{ ...baseFiles[0], content: "corrected" }],
        replaceAll: false,
        ...extra,
      });

      await t.test(
        "HTTP retry admission and foreground file save do not reacquire their own lock",
        async () => {
          await reset();
          const res = await admit();
          assert.equal(await canLock(), false);
          // The old path demonstrably conflicts on another connection.
          await assert.rejects(
            db.transaction(async (tx) => {
              await tx.execute(orm.sql.raw("SET LOCAL lock_timeout = '100ms'"));
              await tx.execute(
                orm.sql.raw("SELECT pg_advisory_xact_lock(" + namespace + "," + projectId + ")"),
              );
            }),
            (error) => (error.cause?.code ?? error.code) === "55P03",
          );
          const child = await lifecycle.withResponseProjectLifecycleTransaction(
            res,
            projectId,
            createTask(),
          );
          await db
            .update(agentTasksTable)
            .set({ status: "building" })
            .where(orm.eq(agentTasksTable.id, child.id));
          await writer.writeProjectFilesAtomically(
            input({
              lifecycleResponse: res,
              expectedBase: { fingerprint, taskId: child.id, ownerUserId: owner },
            }),
          );
          assert.equal((await db.select().from(projectFilesTable))[0].content, "corrected");
          assert.equal(
            (await db.select().from(agentTasksTable).where(orm.eq(agentTasksTable.id, 320)))[0]
              .report.retryChildTaskId,
            child.id,
          );
          assert.equal(child.prompt, originalRequest);
          assert.equal(await canLock(), false);
          await finish(res);
        },
      );
      await t.test(
        "two concurrent retry claims produce one child and one non-revealing rejection",
        async () => {
          await reset();
          const results = await Promise.allSettled([
            db.transaction(createTask()),
            db.transaction(createTask()),
          ]);
          assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
          const failure = results.find((r) => r.status === "rejected");
          assert.equal(failure.reason.code, "failed_draft_recovery_unavailable");
          const rows = await db.select().from(agentTasksTable);
          assert.equal(rows.length, 2);
          assert.equal(
            rows.find((row) => row.id === 320).report.retryChildTaskId,
            rows.find((row) => row.id !== 320).id,
          );
        },
      );
      await t.test(
        "rollback never leaves an orphan retry child or a consumed source claim",
        async () => {
          await reset();
          await assert.rejects(
            db.transaction(async (tx) => {
              await createTask()(tx);
              throw new Error("synthetic commit failure");
            }),
            /synthetic commit failure/,
          );
          const rows = await db.select().from(agentTasksTable);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].report, null);
        },
      );
      await t.test(
        "connection close pins the admitted lock until the transaction ends",
        async () => {
          await reset();
          const res = await admit();
          await lifecycle.withResponseProjectLifecycleTransaction(res, projectId, async (tx) => {
            res.destroyed = true;
            res.emit("close");
            assert.equal(lifecycle.transactionHoldsProjectLifecycleLock(tx, projectId), true);
            assert.equal(await canLock(), false);
          });
          assert.equal(await canLock(), true);
        },
      );
      await t.test(
        "forged locals and a genuine but wrong-project response cannot authorize a save",
        async () => {
          await reset();
          const res = await admit();
          const forged = { locals: res.locals, destroyed: false, writableEnded: false };
          await assert.rejects(
            writer.writeProjectFilesAtomically(input({ lifecycleResponse: forged })),
            (error) => error.cause?.message === "project_lifecycle_session_missing",
          );
          await assert.rejects(
            lifecycle.withResponseProjectLifecycleTransaction(res, projectId + 1, async () =>
              assert.fail("must not enter"),
            ),
            /project_lifecycle_session_missing/,
          );
          assert.equal((await db.select().from(projectFilesTable))[0].content, "original");
          await finish(res);
        },
      );
      await t.test(
        "an ended foreground response reacquires a fresh lock and still rejects Trash",
        async () => {
          await reset();
          const res = await admit();
          await finish(res);
          await writer.writeProjectFilesAtomically(input({ lifecycleResponse: res }));
          await db.update(projectsTable).set({ deletedAt: new Date() });
          await assert.rejects(
            writer.writeProjectFilesAtomically(input({ lifecycleResponse: res })),
            (error) => error.code === "project_inactive",
          );
          assert.equal((await db.select().from(projectFilesTable))[0].content, "corrected");
        },
      );
      await t.test(
        "standalone background file saves wait for the lifecycle lock only for the bounded timeout",
        async () => {
          await reset();
          const res = await admit();
          const started = Date.now();
          await assert.rejects(
            writer.writeProjectFilesAtomically(input()),
            (error) => (error.cause?.cause?.code ?? error.cause?.code) === "55P03",
          );
          assert.ok(Date.now() - started < 4500);
          assert.equal((await db.select().from(projectFilesTable))[0].content, "original");
          await finish(res);
        },
      );
      await t.test(
        "asset-reference failure rolls back the real file and reference rows together",
        async () => {
          await reset();
          failReconciliation = true;
          await assert.rejects(writer.writeProjectFilesAtomically(input()), /could not be saved/);
          assert.equal((await db.select().from(projectFilesTable))[0].content, "original");
          assert.equal((await db.select().from(usages)).length, 0);
        },
      );
      await t.test("nested background lifecycle ownership is genuine and reusable", async () => {
        await reset();
        const result = await lifecycle.withActiveProjectLifecycle(projectId, () =>
          writer.writeProjectFilesAtomically(input()),
        );
        assert.equal(result.state, "active");
        assert.equal((await db.select().from(projectFilesTable))[0].content, "corrected");
        assert.equal(await canLock(), true);
      });
      await t.test(
        "all foreground job writes carry the witness but no request field accepts it",
        () => {
          const jobs = source("artifacts/api-server/src/lib/jobs.ts");
          const run = jobs.slice(
            jobs.indexOf("export async function runJob"),
            jobs.indexOf("async function runPostWriteMigrationSync"),
          );
          const writes = [
            ...run.matchAll(
              /await writeProjectFilesAtomically\(\{\s*lifecycleResponse: input.lifecycleResponse,/g,
            ),
          ];
          assert.equal(writes.length, 4);
          assert.equal((route.match(/lifecycleResponse: res,/g) ?? []).length, 1);
          assert.ok(
            route.includes("withResponseProjectLifecycleTransaction(res, project.id, createTask)"),
          );
        },
      );
      await t.test(
        "owner Stop reaches a lock-owning worker and replays its terminal without another refund",
        async () => {
          await reset();
          const [task] = await db
            .insert(agentTasksTable)
            .values({
              projectId,
              status: "building",
              kind: "main",
              intentReceiptId: 67,
            })
            .returning();
          const holder = await admit();
          assert.equal(await canLock(), false);
          const controller = new AbortController();
          const terminal = {
            schema: "zero-terminal-v1",
            taskId: task.id,
            intent: "mutate",
            intentReceiptId: 67,
            completedAt: new Date().toISOString(),
            outcome: "interrupted",
            runStatus: "interrupted",
            cause: "user_stop",
            evidence: { lastPhase: "agent_loop", changedPaths: [] },
          };
          let signalCount = 0;
          let workerStopped = Promise.resolve();
          controller.signal.addEventListener(
            "abort",
            () => {
              workerStopped = (async () => {
                await db
                  .update(agentTasksTable)
                  .set({ status: "canceled", terminal })
                  .where(orm.eq(agentTasksTable.id, task.id));
                await finish(holder);
              })();
            },
            { once: true },
          );
          const cancelActiveJob = (id) => {
            assert.equal(id, task.id);
            signalCount += 1;
            controller.abort();
            return true;
          };
          const requireProjectOwnership = async (req, res, next) => {
            const [project] = await db
              .select()
              .from(projectsTable)
              .where(
                orm.and(
                  orm.eq(projectsTable.id, Number(req.params.id)),
                  orm.isNull(projectsTable.deletedAt),
                ),
              );
            if (project?.ownerId !== req.userId) {
              res.status(404).json({ error: "Project not found" });
              return;
            }
            next();
          };
          const receipt = sourceModule("artifacts/api-server/src/lib/confirmed-user-stop.ts", {
            "@workspace/ora-contracts": oraContracts,
          });
          const apiZod = requireApi("@workspace/api-zod");
          const signalRouter = sourceModule(
            "artifacts/api-server/src/routes/task-cancellation-signal.ts",
            {
              express,
              "drizzle-orm": orm,
              "@workspace/db": dbModule,
              "@workspace/api-zod": apiZod,
              "../lib/auth": { requireProjectOwnership },
              "../lib/jobs": { cancelActiveJob },
              "../lib/confirmed-user-stop": receipt,
            },
          ).default;
          const taskSource = source("artifacts/api-server/src/routes/tasks.ts");
          const cancelStart = taskSource.indexOf(
            'router.post(\n  "/projects/:id/tasks/:taskId/cancel",',
          );
          const cancelEnd = taskSource.indexOf("\nrouter.post(", cancelStart + 1);
          assert.ok(cancelStart >= 0 && cancelEnd > cancelStart);
          const cancellationRouter = express.Router();
          compile(
            taskSource.slice(cancelStart, cancelEnd),
            "tasks.cancel-handler.ts",
            {},
            {
              router: cancellationRouter,
              requireProjectOwnership,
              CancelTaskParams: apiZod.CancelTaskParams,
              db,
              ...tables,
              ...orm,
              ...receipt,
              cancelActiveJob,
              persistInterruptedZeroTerminal() {
                assert.fail("worker already owns the canonical terminal");
              },
              refundCredits() {
                assert.fail("replay must not repeat a refund");
              },
            },
          );
          const indexSource = source("artifacts/api-server/src/routes/index.ts");
          const signalMount = indexSource.indexOf("router.use(taskCancellationSignalRouter)");
          const fenceMount = indexSource.indexOf(
            "router.use(requireActiveProjectMutationLifecycleSession)",
          );
          assert.ok(
            signalMount >= 0 && fenceMount > signalMount,
            "production mounts the signal before the lifecycle fence",
          );
          const server = express();
          server.use((req, _res, next) => {
            req.userId = owner;
            next();
          });
          server.use(signalRouter);
          server.use((_req, res, next) =>
            lifecycle.requireActiveProjectLifecycleFor(projectId, res, next),
          );
          server.use(cancellationRouter);
          const cancellationPath = `/projects/${projectId}/tasks/${task.id}/cancel`;
          try {
            const started = Date.now();
            const first = await request(server).post(cancellationPath).timeout({ deadline: 10000 });
            assert.equal(first.status, 200);
            assert.ok(
              Date.now() - started < 8000,
              "Stop must not wait for the 15-second lifecycle timeout",
            );
            assert.equal(first.body.status, "canceled");
            assert.deepEqual(first.body.terminal, terminal);
            await workerStopped;
            const replay = await request(server)
              .post(cancellationPath)
              .timeout({ deadline: 10000 });
            assert.equal(replay.status, 200);
            assert.deepEqual(replay.body, first.body);
            assert.equal(signalCount, 1);
          } finally {
            await workerStopped;
            await finish(holder);
          }
        },
      );
      t.diagnostic(
        "DATABASE=ora_gate_disposable_c84abf01fb72451b; ENVIRONMENT=lab; KIND=real-PostgreSQL-lock-and-transaction-regression. Synthetic schema only; artifact resolution and provider cleanup are not evaluated here.",
      );
    } finally {
      for (const res of responses) {
        res.writableEnded = true;
        res.emit("finish");
      }
      probe?.release();
      if (pool) await pool.end();
      if (schemaCreated) {
        assert.match(schema, /^jrn77_lock_[a-f0-9]{32}$/);
        await admin.query("DROP SCHEMA " + q(schema) + " CASCADE");
      }
      await admin.end();
    }
  },
);
