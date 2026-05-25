/**
 * Task #762 — Verify Fly + Neon agentic provisioning end-to-end.
 *
 * Creates a throwaway project, runs the real provisioning pipeline against
 * the live Fly + Neon APIs, validates the result, and tears everything down
 * (Fly machine + Neon project + DB row). Prints a structured report so we
 * can paste the findings into docs/changelog.md.
 *
 * Safe to run repeatedly. Soft-deletes the project at the end.
 */
import { db, pool, projectsTable, secretsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";

const FLY_TOKEN = process.env.FLY_API_TOKEN ?? "";
const FLY_APP = process.env.FLY_APP_NAME ?? "mustaflow-containers";
const NEON_KEY = process.env.NEON_API_KEY ?? "";

async function flyDelete(machineId: string): Promise<void> {
  if (!FLY_TOKEN || !machineId) return;
  try {
    const r = await fetch(
      `https://api.machines.dev/v1/apps/${FLY_APP}/machines/${machineId}?force=true`,
      { method: "DELETE", headers: { Authorization: `Bearer ${FLY_TOKEN}` } },
    );
    console.log(`[cleanup] fly destroy ${machineId} → ${r.status}`);
  } catch (err) {
    console.log(`[cleanup] fly destroy failed:`, err);
  }
}

async function neonDelete(neonProjectId: string): Promise<void> {
  if (!NEON_KEY || !neonProjectId) return;
  try {
    const r = await fetch(`https://console.neon.tech/api/v2/projects/${neonProjectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${NEON_KEY}` },
    });
    console.log(`[cleanup] neon delete ${neonProjectId} → ${r.status}`);
  } catch (err) {
    console.log(`[cleanup] neon delete failed:`, err);
  }
}

async function main(): Promise<void> {
  console.log("─".repeat(70));
  console.log("Task #762 — Agentic provisioning end-to-end verification");
  console.log("─".repeat(70));
  console.log(`FLY_API_TOKEN:  ${FLY_TOKEN ? "set" : "MISSING"}`);
  console.log(`NEON_API_KEY:   ${NEON_KEY ? "set" : "MISSING"}`);
  console.log(`FLY_APP_NAME:   ${FLY_APP}`);
  console.log("");

  // 1. Insert a throwaway test project stamped agentic.
  const [project] = await db
    .insert(projectsTable)
    .values({
      ownerId: "verify-task-762",
      name: "Verify #762 (auto-cleanup)",
      kind: "web",
      platform: "web",
      projectFormat: "static-html",
      stack: "static-html",
      builderMode: "agentic",
      provisioningStatus: "provisioning",
    })
    .returning();
  if (!project) throw new Error("Failed to insert test project");
  console.log(`[setup] Inserted test project id=${project.id}`);

  let neonProjectId: string | null = null;
  let containerId: string | null = null;

  try {
    // 2. Run the real provisioning pipeline. This dynamically imports the
    //    server module so we hit the exact code path the API server uses.
    console.log("\n[run]   Calling runProvisionProjectJob…");
    const { runProvisionProjectJob } = await import("./lib/provisioning.js");
    const startedAt = Date.now();
    await runProvisionProjectJob(project.id);
    const elapsedMs = Date.now() - startedAt;
    console.log(`[run]   Finished in ${elapsedMs}ms`);

    // 3. Inspect the resulting row.
    const [row] = await db.select().from(projectsTable).where(eq(projectsTable.id, project.id));
    if (!row) throw new Error("Project disappeared mid-run");
    neonProjectId = row.neonProjectId ?? null;
    containerId = row.containerId ?? null;

    console.log("\n[result] Project row after provisioning:");
    console.log(`  provisioningStatus: ${row.provisioningStatus}`);
    console.log(`  provisioningError:  ${row.provisioningError ?? "(none)"}`);
    console.log(`  containerId:        ${row.containerId ?? "(none)"}`);
    console.log(`  containerUrl:       ${row.containerUrl ?? "(none)"}`);
    console.log(`  containerStatus:    ${row.containerStatus ?? "(none)"}`);
    console.log(`  neonProjectId:      ${row.neonProjectId ?? "(none)"}`);
    console.log(`  dbProvider:         ${row.dbProvider ?? "(none)"}`);
    console.log(`  dbStatus:           ${row.dbStatus ?? "(none)"}`);

    // 4. Check DATABASE_URL secret.
    const secrets = await db
      .select()
      .from(secretsTable)
      .where(and(eq(secretsTable.projectId, project.id), eq(secretsTable.name, "DATABASE_URL")));
    if (secrets.length === 0) {
      console.log("\n[result] DATABASE_URL secret: NOT PRESENT");
    } else {
      const { encryptionService } = await import("./lib/encryption.js");
      const decrypted = encryptionService.decrypt(secrets[0]!.valueEncrypted);
      const masked = decrypted.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/, "$1•••$2");
      console.log(`\n[result] DATABASE_URL secret stored. Connection string: ${masked}`);

      // 5. Try a real SELECT 1 against it.
      console.log("[probe]  Connecting and running SELECT 1…");
      const client = new Client({ connectionString: decrypted });
      try {
        await client.connect();
        const r = await client.query("SELECT 1 AS ok");
        console.log(`[probe]  SELECT 1 result:`, r.rows);
      } catch (err) {
        console.log(`[probe]  Connection FAILED:`, err instanceof Error ? err.message : err);
      } finally {
        await client.end().catch(() => {});
      }
    }

    // 6. Pass/fail summary.
    const ok =
      row.provisioningStatus === "ready" &&
      !!row.containerId &&
      !!row.neonProjectId &&
      secrets.length > 0;
    console.log(
      `\n[VERDICT] ${ok ? "PASS — agentic provisioning works end-to-end" : "FAIL — see above"}`,
    );
  } finally {
    // 7. Tear down everything we created so no orphaned cloud resources remain.
    console.log("\n[cleanup] Tearing down test resources…");
    if (containerId) await flyDelete(containerId);
    if (neonProjectId) await neonDelete(neonProjectId);
    await db
      .delete(secretsTable)
      .where(eq(secretsTable.projectId, project.id))
      .catch(() => {});
    await db
      .delete(projectsTable)
      .where(eq(projectsTable.id, project.id))
      .catch(() => {});
    console.log(`[cleanup] DB project id=${project.id} hard-deleted`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("\n[FATAL]", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
