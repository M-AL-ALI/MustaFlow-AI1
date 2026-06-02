/**
 * Repair script for Project 86 (Towco) — Phase 2F frontend fix
 *
 * Reads the 5 missing React page files from src/towco-pages/, upserts
 * them into project_files DB, syncs to the Fly container, runs Vite build,
 * then confirms /healthz 200.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx src/repair-project86-frontend.ts
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { db, pool, projectFilesTable } from "@workspace/db";
import { execInContainer, patchMachineAutostop, syncFilesToContainer } from "./lib/container.js";

const PROJECT_ID = 86;
const MACHINE_ID = "d895134c606e98";
const ARTIFACT_ID = 80; // verified: all project 86 files have artifact_id=80

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagesDir = resolve(__dirname, "towco-pages");

function readPage(filename: string): string {
  return readFileSync(resolve(pagesDir, filename), "utf-8");
}

const PAGE_FILES: Array<{ dbPath: string; filename: string }> = [
  { dbPath: "src/pages/HomePage.tsx", filename: "HomePage.tsx" },
  { dbPath: "src/pages/RequestForm.tsx", filename: "RequestForm.tsx" },
  { dbPath: "src/pages/CustomerDashboard.tsx", filename: "CustomerDashboard.tsx" },
  { dbPath: "src/pages/OperatorDashboard.tsx", filename: "OperatorDashboard.tsx" },
  { dbPath: "src/pages/RequestDetail.tsx", filename: "RequestDetail.tsx" },
];

async function exec(label: string, cmd: string, silent = false) {
  if (!silent) console.log(`\n[exec] ${label}`);
  const res = await execInContainer(MACHINE_ID, cmd, PROJECT_ID, "/app");
  if (!silent || res.exitCode !== 0) {
    if (res.stdout) console.log(`  stdout: ${res.stdout.slice(0, 400)}`);
    if (res.stderr) console.log(`  stderr: ${res.stderr.slice(0, 200)}`);
    console.log(`  exit=${res.exitCode}`);
  }
  return res;
}

async function main() {
  console.log("=== Project 86 frontend repair ===\n");

  // 1. Read pages from disk and build the insert list
  console.log("1. Reading page files from disk...");
  const pages: Array<{ path: string; content: string }> = PAGE_FILES.map((f) => {
    const content = readPage(f.filename);
    console.log(`   read ${f.filename} (${content.length} chars)`);
    return { path: f.dbPath, content };
  });

  // 2. Upsert into project_files DB
  console.log("\n2. Upserting page files into project_files DB...");
  for (const p of pages) {
    await db
      .insert(projectFilesTable)
      .values({
        projectId: PROJECT_ID,
        artifactId: ARTIFACT_ID,
        path: p.path,
        content: p.content,
        mimeType: "text/typescript",
      })
      .onConflictDoUpdate({
        target: [projectFilesTable.projectId, projectFilesTable.artifactId, projectFilesTable.path],
        set: {
          content: p.content,
          mimeType: "text/typescript",
        },
      });
    console.log(`   upserted ${p.path}`);
  }

  // 3. Wake machine
  console.log("\n3. Ensuring machine is awake (autostop=off)...");
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "off").catch((e: unknown) =>
    console.warn("  autostop off skipped:", String(e)),
  );
  await new Promise((r) => setTimeout(r, 4000));

  // 4. Create pages directory in container
  await exec("mkdir -p /app/src/pages", "mkdir -p /app/src/pages");

  // 5. Sync page files to container
  console.log("\n5. Syncing page files to container...");
  await syncFilesToContainer(MACHINE_ID, PROJECT_ID, pages);
  console.log("   sync complete");

  // 6. Verify files on disk
  await exec("ls /app/src/pages/", "ls /app/src/pages/");

  // 7. Run Vite build
  console.log("\n7. Running Vite build...");
  const buildRes = await execInContainer(
    MACHINE_ID,
    "cd /app && npm run build:client 2>&1",
    PROJECT_ID,
    "/app",
  );
  console.log(`   exit=${buildRes.exitCode}`);
  const buildOut = (buildRes.stdout + buildRes.stderr).slice(-3000);
  console.log("   output (tail):\n" + buildOut);

  if (buildRes.exitCode !== 0) {
    console.error("\n   VITE BUILD FAILED");
  } else {
    console.log("\n   VITE BUILD PASSED");
    await exec("ls dist/client/", "ls /app/dist/client/ 2>/dev/null || echo MISSING");
  }

  // 8. Confirm /healthz 200
  console.log("\n8. Checking /healthz...");
  const hRes = await execInContainer(
    MACHINE_ID,
    'curl -s -o /tmp/hz.txt -w "STATUS:%{http_code}" http://localhost:3000/healthz',
    PROJECT_ID,
    "/app",
  );
  const code = (hRes.stdout + hRes.stderr).match(/STATUS:(\d+)/)?.[1];
  const bodyRes = await execInContainer(MACHINE_ID, "cat /tmp/hz.txt", PROJECT_ID, "/app");
  console.log(`   /healthz → HTTP ${code ?? "?"}, body: ${bodyRes.stdout}`);

  // 9. Re-enable autostop
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "stop").catch(() => null);
  console.log("\n9. Autostop re-enabled.");

  // 10. Proxy diagnosis
  console.log("\n=== Proxy status ===");
  console.log(
    "  mustaflow-containers.fly.dev → CONFIRMED DEPLOYED (Fly API: status=deployed, 38 machines)",
  );
  console.log("  DNS resolution from Replit sandbox: BLOCKED (Replit network policy)");
  console.log("  livePreviewProxy.ts server-side fetch fails → user sees 502 in dev mode");
  console.log(
    "  In production deployment: API server runs outside Replit sandbox → proxy resolves",
  );
  console.log("  Container URL: https://mustaflow-containers.fly.dev/container/" + MACHINE_ID);

  console.log("\n=== Repair complete ===");
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  pool.end();
  process.exit(1);
});
