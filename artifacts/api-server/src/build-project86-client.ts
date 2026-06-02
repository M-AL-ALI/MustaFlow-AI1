/**
 * Build the Towco (project 86) React client locally on Replit,
 * then sync the built dist/client/ into the Fly container.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx src/build-project86-client.ts
 *
 * Strategy:
 *  1. Export project files from DB to /tmp/towco-build/
 *  2. npm install (full deps) locally — no container RAM limit here
 *  3. vite build → /tmp/towco-build/dist/client/
 *  4. Sync built dist/client/ files to the container (/app/dist/client/)
 *  5. Slim yarn install (server runtime deps only) in container
 *  6. Start the express server, confirm /healthz 200
 */
import { execSync, spawnSync } from "child_process";
import { db, projectFilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import {
  execInContainer,
  syncFilesToContainer,
  patchMachineAutostop,
  startContainerHealthServer,
} from "./lib/container";

const MACHINE_ID = "d895134c606e98";
const PROJECT_ID = 86;
const BUILD_DIR = "/tmp/towco-build";

async function execC(cmd: string[], label: string): Promise<{ ok: boolean; output: string }> {
  console.log(`\n[container] ${label}`);
  const res = await execInContainer(MACHINE_ID, cmd, PROJECT_ID, "/app");
  const out = (res.stdout + res.stderr).trim();
  const preview = out.split("\n").slice(0, 15).join("\n       ").slice(0, 800);
  if (preview) console.log(`       ${preview}`);
  console.log(`       exit=${res.exitCode}`);
  return { ok: res.exitCode === 0, output: out };
}

function sh(cmd: string, cwd?: string): string {
  console.log(`\n[local] ${cmd.slice(0, 120)}`);
  try {
    return execSync(cmd, {
      cwd: cwd ?? BUILD_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = ((err.stdout ?? "") + (err.stderr ?? "")).trim();
    console.error(`       FAILED: ${out.slice(0, 400)}`);
    throw e;
  }
}

async function main() {
  console.log("=== Project 86 — Build client locally + sync to container ===\n");

  // ── 1. Load project files from DB ─────────────────────────────────────────
  console.log("[db] Loading project files...");
  const files = await db
    .select({ path: projectFilesTable.path, content: projectFilesTable.content })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, PROJECT_ID));
  console.log(`[db] ${files.length} files loaded`);

  // ── 2. Write files to build dir ───────────────────────────────────────────
  if (fs.existsSync(BUILD_DIR)) fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  for (const f of files) {
    const dest = path.join(BUILD_DIR, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.content ?? "", "utf8");
  }
  console.log(`[local] Wrote ${files.length} files to ${BUILD_DIR}`);

  // ── 3. npm install (full deps) locally ────────────────────────────────────
  console.log("\n── npm install (local, full deps) ──");
  sh("npm install --no-audit --no-fund --prefer-offline 2>&1 | tail -5");
  const tsxPresent = fs.existsSync(path.join(BUILD_DIR, "node_modules/.bin/tsx"));
  const vitePresent = fs.existsSync(path.join(BUILD_DIR, "node_modules/.bin/vite"));
  console.log(
    `[local] tsx: ${tsxPresent ? "PRESENT" : "MISSING"}, vite: ${vitePresent ? "PRESENT" : "MISSING"}`,
  );

  // ── 4. vite build → dist/client/ ──────────────────────────────────────────
  if (!vitePresent) {
    console.error("[FATAL] vite not installed locally — cannot build client");
    process.exit(1);
  }
  console.log("\n── vite build (local) ──");
  sh("node_modules/.bin/vite build 2>&1 | tail -20");

  const distDir = path.join(BUILD_DIR, "dist/client");
  if (!fs.existsSync(distDir)) {
    console.error("[FATAL] dist/client does not exist after vite build");
    process.exit(1);
  }
  const builtFiles: string[] = [];
  function collect(dir: string) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        collect(full);
      } else {
        builtFiles.push(full);
      }
    }
  }
  collect(distDir);
  console.log(`[local] vite build succeeded — ${builtFiles.length} output files`);

  // ── 5. Wake container + autostop off ──────────────────────────────────────
  console.log("\n── Waking container ──");
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "off").catch((e: unknown) =>
    console.warn("patchMachineAutostop warn:", e),
  );
  await startContainerHealthServer(MACHINE_ID, PROJECT_ID).catch((e: unknown) =>
    console.warn("startContainerHealthServer warn:", e),
  );

  // ── 6. Sync project source files to container ─────────────────────────────
  console.log("\n── Syncing project files to container ──");
  await syncFilesToContainer(MACHINE_ID, PROJECT_ID, files);
  console.log("[sync] Project files synced");

  // ── 7. Sync built dist/client/ to container ───────────────────────────────
  console.log("\n── Syncing built dist/client/ to container ──");
  const distFilesForSync = builtFiles.map((full) => {
    const rel = path.relative(BUILD_DIR, full);
    return { path: rel, content: fs.readFileSync(full, "utf8") };
  });
  await syncFilesToContainer(MACHINE_ID, PROJECT_ID, distFilesForSync);
  console.log(`[sync] ${distFilesForSync.length} built client files synced to /app/dist/client/`);

  // ── 8. Slim yarn install in container (runtime deps only) ─────────────────
  // Use the slim package.json approach — it only installs what the express
  // server needs at runtime (express, cors, pg, drizzle-orm, uuid, tsx).
  // The built client is already in /app/dist/client/ from step 7.
  console.log("\n── Container: slim deps via yarn ──");
  const slimPkg = JSON.stringify(
    {
      name: "towco",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { start: "tsx src/server/index.ts" },
      dependencies: {
        cors: "^2.8.5",
        "drizzle-orm": "^0.30.10",
        express: "^4.18.3",
        pg: "^8.11.5",
        uuid: "^9.0.1",
      },
      devDependencies: { tsx: "^4.7.3" },
    },
    null,
    2,
  );
  const escaped = slimPkg.replace(/'/g, "'\\''");
  await execC(
    ["sh", "-c", `printf '%s' '${escaped}' > /app/package.json && echo WRITTEN`],
    "write slim package.json",
  );
  await execC(
    [
      "sh",
      "-c",
      "rm -rf /app/node_modules /app/package-lock.json /app/yarn.lock /.npm /root/.npm 2>/dev/null; mkdir -p /.npm; true",
    ],
    "clean node_modules",
  );
  await execC(
    ["sh", "-c", "yarn cache clean drizzle-orm 2>/dev/null; true"],
    "clear drizzle-orm yarn cache",
  );
  const yarnRes = await execC(
    [
      "sh",
      "-c",
      "cd /app && yarn install --non-interactive --network-timeout 60000 2>&1 && echo YARN_OK || echo YARN_FAIL",
    ],
    "yarn install (slim)",
  );
  if (!yarnRes.output.includes("YARN_OK")) {
    console.error("[FATAL] yarn install failed");
    await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "stop").catch(() => null);
    process.exit(1);
  }
  const tsxCheck = await execC(
    ["sh", "-c", "ls /app/node_modules/.bin/tsx 2>/dev/null && echo PRESENT || echo MISSING"],
    "tsx check",
  );
  if (!tsxCheck.output.includes("PRESENT")) {
    console.error("[FATAL] tsx binary not found after yarn install");
    await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "stop").catch(() => null);
    process.exit(1);
  }

  // ── 9. Kill stale servers + start express ─────────────────────────────────
  console.log("\n── Starting express server ──");
  await execC(
    [
      "sh",
      "-c",
      "pkill -9 -f tsx 2>/dev/null; pkill -9 -f server 2>/dev/null; pkill -9 -f fly-health 2>/dev/null; sleep 1; true",
    ],
    "kill stale servers",
  );
  await execC(
    [
      "sh",
      "-c",
      "cd /app && rm -f /tmp/server.log && nohup sh -c 'cd /app && PORT=3000 /app/node_modules/.bin/tsx src/server/index.ts > /tmp/server.log 2>&1' </dev/null >/dev/null 2>&1 & echo PID=$!",
    ],
    "start tsx server",
  );

  // ── 10. Poll /healthz ─────────────────────────────────────────────────────
  console.log("\n[healthz] Waiting for server (up to 60s)...");
  let healthy = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const hres = await execC(
      [
        "node",
        "-e",
        `const h=require('http');h.get('http://localhost:3000/healthz',(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{process.stdout.write('STATUS:'+r.statusCode+' '+d.slice(0,100));process.exit(r.statusCode===200?0:1)})}).on('error',(e)=>{process.stdout.write('ERR:'+e.message);process.exit(1)})`,
      ],
      `GET /healthz (${i + 1}/12)`,
    );
    if (hres.ok) {
      healthy = true;
      break;
    }
    if (i === 2) {
      await execC(
        ["sh", "-c", "tail -20 /tmp/server.log 2>/dev/null || echo '(no log)'"],
        "server log (15s)",
      );
    }
  }

  if (!healthy) {
    await execC(
      ["sh", "-c", "tail -40 /tmp/server.log 2>/dev/null || echo '(no log)'"],
      "server startup log",
    );
  }

  // ── 11. Check root / returns something (not 404) ──────────────────────────
  if (healthy) {
    const rootRes = await execC(
      [
        "node",
        "-e",
        `const h=require('http');h.get('http://localhost:3000/',(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{process.stdout.write('ROOT_STATUS:'+r.statusCode+' '+d.slice(0,200));process.exit(r.statusCode<400?0:1)})}).on('error',(e)=>{process.stdout.write('ERR:'+e.message);process.exit(1)})`,
      ],
      "GET / (Towco UI root)",
    );
    if (rootRes.ok) {
      console.log("\n[check] GET / → Towco UI served ✓");
    } else {
      console.warn("\n[check] GET / returned non-2xx — dist/client may be missing");
    }
  }

  // ── 12. Re-enable autostop ────────────────────────────────────────────────
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "stop").catch(() => null);

  console.log(`\n=== RESULT: /healthz ${healthy ? "200 OK — RUNNING ✓" : "FAILED ✗"} ===`);
  process.exit(healthy ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error("Fatal:", e);
  process.exit(1);
});
