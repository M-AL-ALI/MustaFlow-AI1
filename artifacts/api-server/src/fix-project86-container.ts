/**
 * Direct container fix for project 86.
 * Run with: pnpm --filter @workspace/api-server exec tsx src/fix-project86-container.ts
 *
 * Root causes:
 *  1. /app empty on machine restart (writable layer resets)
 *  2. npm install hangs or OOM-kills (empty /tmp/.npm-out after 8 min)
 *  3. 429 retry double-exec bug (fixed in npmInstallInBackground)
 *
 * Strategy: try multiple install approaches until one succeeds, then start server.
 */
import { db, projectFilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  execInContainer,
  syncFilesToContainer,
  patchMachineAutostop,
  startContainerHealthServer,
} from "./lib/container";

const MACHINE_ID = "d895134c606e98";
const PROJECT_ID = 86;

// Minimal runtime-only package.json
const SLIM_PKG = JSON.stringify(
  {
    name: "towco",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { dev: "tsx watch src/server/index.ts", start: "tsx src/server/index.ts" },
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

async function run(
  cmd: string[],
  label: string,
  opts: { silent?: boolean } = {},
): Promise<{ ok: boolean; output: string; exitCode: number }> {
  if (!opts.silent) console.log(`\n[exec] ${label}`);
  const res = await execInContainer(MACHINE_ID, cmd, PROJECT_ID, "/app");
  const out = (res.stdout + res.stderr).trim();
  if (!opts.silent) {
    const preview = out.split("\n").slice(0, 20).join("\n       ").slice(0, 1200);
    if (preview) console.log(`       ${preview}`);
    console.log(`       exit=${res.exitCode}`);
  }
  return { ok: res.ok && res.exitCode === 0, output: out, exitCode: res.exitCode };
}

async function main() {
  console.log("=== Project 86 Container Fix ===\n");

  // ── 1. Machine up + autostop disabled ────────────────────────────────────
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "off").catch((e: unknown) =>
    console.warn("patchMachineAutostop warn:", e),
  );
  await startContainerHealthServer(MACHINE_ID, PROJECT_ID).catch((e: unknown) =>
    console.warn("startContainerHealthServer warn:", e),
  );

  // ── 2. Container diagnostics (memory, network, node/npm) ─────────────────
  await run(["sh", "-c", "free -m 2>/dev/null | head -3 || true"], "memory");
  await run(["sh", "-c", "node --version && npm --version && (which yarn || echo 'no yarn')"], "node/npm/yarn versions");
  await run(["sh", "-c", "nslookup registry.npmjs.org 2>&1 | head -5 || curl -s --max-time 5 https://registry.npmjs.org/ | head -3 2>/dev/null || echo 'network check failed'"], "npm registry reachability");

  // ── 3. Sync project files from DB ────────────────────────────────────────
  console.log("\n[sync] Loading files from DB...");
  const files = await db
    .select({ path: projectFilesTable.path, content: projectFilesTable.content })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, PROJECT_ID));
  console.log(`[sync] ${files.length} files → syncing...`);
  await syncFilesToContainer(MACHINE_ID, PROJECT_ID, files);
  console.log("[sync] Done");

  // ── 4. Write slim package.json ────────────────────────────────────────────
  const escapedPkg = SLIM_PKG.replace(/'/g, "'\\''");
  const writeRes = await run(
    ["sh", "-c", `printf '%s' '${escapedPkg}' > /app/package.json && echo WRITTEN`],
    "write slim package.json",
  );
  if (!writeRes.output.includes("WRITTEN")) {
    console.error("Failed to write slim package.json"); process.exit(1);
  }

  // ── 5. Clean stale state ──────────────────────────────────────────────────
  await run(
    ["sh", "-c", "rm -rf /app/node_modules /app/package-lock.json /app/yarn.lock /.npm /root/.npm 2>/dev/null; mkdir -p /.npm; true"],
    "clean stale state",
  );

  // ── 6. APPROACH A: Synchronous npm install (captures output, 290s timeout) ─
  console.log("\n── APPROACH A: Synchronous npm install ──");
  // Single packages one at a time uses less concurrent memory
  const singlePkgs = ["express", "cors", "pg", "uuid", "drizzle-orm", "tsx"];
  let installed = false;

  // First, try a single-shot synchronous npm install of just tsx (lightweight).
  // If that works, install the rest individually.
  console.log("[approach-a] Installing tsx alone first as probe...");
  const tsxInstall = await run(
    ["sh", "-c", "cd /app && npm install --save-dev --no-audit --no-fund --no-progress tsx@^4.7.3 2>&1 && echo NPM_OK || echo NPM_FAIL"],
    "npm install tsx alone",
  );
  if (tsxInstall.output.includes("NPM_OK")) {
    console.log("[approach-a] tsx installed, installing remaining packages...");
    for (const pkg of ["express", "cors", "pg", "uuid", "drizzle-orm"]) {
      const r = await run(
        ["sh", "-c", `cd /app && npm install --save --no-audit --no-fund --no-progress ${pkg} 2>&1 && echo NPM_OK || echo NPM_FAIL`],
        `npm install ${pkg}`,
      );
      if (!r.output.includes("NPM_OK")) {
        console.warn(`[approach-a] ${pkg} install failed — continuing with next`);
      }
    }
    const tsxBin = await run(
      ["sh", "-c", "ls /app/node_modules/.bin/tsx 2>/dev/null && echo PRESENT || echo MISSING"],
      "tsx check after approach-a",
    );
    installed = tsxBin.output.includes("PRESENT");
  } else {
    console.log("[approach-a] tsx install failed — trying approach B");
    // Show what went wrong
    console.log("[approach-a] output:", tsxInstall.output.slice(0, 500));
  }

  // ── 7. APPROACH B: Yarn install ───────────────────────────────────────────
  if (!installed) {
    console.log("\n── APPROACH B: Yarn install ──");
    // yarn v1.22 is known to be available on Alpine in these containers
    await run(["sh", "-c", "rm -f /app/yarn.lock"], "remove yarn.lock");
    const yarnInstall = await run(
      ["sh", "-c", "cd /app && yarn install --non-interactive --prefer-offline 2>&1 && echo YARN_OK || echo YARN_FAIL"],
      "yarn install",
    );
    if (yarnInstall.output.includes("YARN_OK")) {
      const tsxBin = await run(
        ["sh", "-c", "ls /app/node_modules/.bin/tsx 2>/dev/null && echo PRESENT || echo MISSING"],
        "tsx check after yarn",
      );
      installed = tsxBin.output.includes("PRESENT");
    } else {
      console.log("[approach-b] yarn output:", yarnInstall.output.slice(0, 500));
    }
  }

  // ── 8. APPROACH C: nohup npm install (background, 10min cap) ─────────────
  if (!installed) {
    console.log("\n── APPROACH C: nohup npm install (background) ──");
    // Kill any existing npm/yarn first
    await run(["sh", "-c", "pkill -f 'npm' 2>/dev/null; pkill -f 'yarn' 2>/dev/null; sleep 2; true"], "kill existing installs");

    // Diagnostic: check network connectivity first
    await run(
      ["sh", "-c", "wget -q --spider --timeout=10 https://registry.npmjs.org/ && echo NET_OK || echo NET_FAIL"],
      "network check via wget",
    );

    await run(
      ["sh", "-c", "rm -f /tmp/.npm-done /tmp/.npm-out && nohup sh -c 'cd /app && npm install --prefer-offline --no-audit --no-fund > /tmp/.npm-out 2>&1; echo $? > /tmp/.npm-done' </dev/null >/dev/null 2>&1 & echo LAUNCHED"],
      "launch nohup npm install",
    );

    // Check immediately what's happening
    await new Promise((r) => setTimeout(r, 5000));
    await run(["sh", "-c", "ps aux 2>/dev/null | grep -E 'npm|node' | grep -v grep | head -10 || true"], "npm process check (5s)");
    await run(["sh", "-c", "cat /tmp/.npm-out 2>/dev/null | head -10 || echo '(empty)'"], "npm output (5s)");
    await run(["sh", "-c", "cat /tmp/.npm-done 2>/dev/null || echo '(not done yet)'"], "npm done (5s)");

    // Poll for up to 10 minutes
    let done = false;
    for (let poll = 0; poll < 120; poll++) {
      await new Promise((r) => setTimeout(r, 5000));
      const check = await run(
        ["sh", "-c", 'if [ -f /tmp/.npm-done ]; then echo "__EXIT_$(cat /tmp/.npm-done)__"; cat /tmp/.npm-out | tail -5; else echo "__RUNNING__ poll=$(ps aux 2>/dev/null | grep npm | grep -v grep | wc -l) procs"; fi'],
        `poll ${poll + 1}/120`,
        { silent: poll % 6 !== 0 }, // only print every 30s
      );
      const m = check.output.match(/__EXIT_(\d+)__/);
      if (m) {
        const exitCode = parseInt(m[1], 10);
        console.log(`[approach-c] npm install done: exit=${exitCode}`);
        console.log("[approach-c] tail:", check.output.slice(0, 300));
        done = true;
        if (exitCode === 0) {
          const tsxBin = await run(
            ["sh", "-c", "ls /app/node_modules/.bin/tsx 2>/dev/null && echo PRESENT || echo MISSING"],
            "tsx check after approach-c",
          );
          installed = tsxBin.output.includes("PRESENT");
        }
        break;
      }
      // Print status every 6 polls (30s)
      if (poll % 6 === 0) {
        console.log(`[approach-c] ${check.output.slice(0, 100)}`);
      }
    }
    if (!done) console.log("[approach-c] timed out after 10 minutes");
  }

  // ── 9. Report install result before proceeding ────────────────────────────
  await run(["sh", "-c", "ls /app/node_modules/ 2>/dev/null | wc -l || echo 0"], "node_modules package count");
  await run(["sh", "-c", "ls /app/node_modules/.bin/ 2>/dev/null | head -20 || echo '(empty)'"], "node_modules/.bin contents");

  if (!installed) {
    console.error("\n[FATAL] All install approaches failed — tsx binary not found");
    await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "stop").catch(() => null);
    process.exit(1);
  }

  // ── 10. Kill stale servers ────────────────────────────────────────────────
  await run(
    ["sh", "-c", "pkill -f 'tsx' 2>/dev/null; pkill -f 'server' 2>/dev/null; pkill -f 'fly-health' 2>/dev/null; sleep 1; true"],
    "kill stale servers",
  );

  // ── 11. Start Express server ──────────────────────────────────────────────
  console.log("\n[server] Starting server...");
  await run(
    ["sh", "-c", "rm -f /tmp/server.log; PORT=3000 nohup /app/node_modules/.bin/tsx watch src/server/index.ts > /tmp/server.log 2>&1 & echo PID=$!"],
    "start tsx server",
  );

  // ── 12. Poll /healthz ─────────────────────────────────────────────────────
  console.log("\n[healthz] Waiting for server (up to 60s)...");
  let healthy = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const hres = await run(
      ["node", "-e", `const h=require('http');h.get('http://localhost:3000/healthz',(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{process.stdout.write('STATUS:'+r.statusCode+' '+d.slice(0,100));process.exit(r.statusCode===200?0:1)})}).on('error',(e)=>{process.stdout.write('ERR:'+e.message);process.exit(1)})`],
      `GET /healthz (${i + 1}/12)`,
    );
    if (hres.ok) { healthy = true; break; }
    if (i === 3) await run(["sh", "-c", "tail -20 /tmp/server.log 2>/dev/null || true"], "server log (20s)");
  }

  if (!healthy) {
    await run(["sh", "-c", "tail -50 /tmp/server.log 2>/dev/null || echo '(no log)'"], "server startup log");
  }

  // ── 13. Re-enable autostop ────────────────────────────────────────────────
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "stop").catch(() => null);

  // ── 14. External Fly URL check ────────────────────────────────────────────
  if (healthy) {
    const flyUrl = `https://mustaflow-containers.fly.dev/container/${MACHINE_ID}/healthz`;
    console.log(`\n[external] GET ${flyUrl}`);
    try {
      const { default: https } = await import("https");
      const statusCode = await new Promise<number>((resolve, reject) => {
        const req = https.get(flyUrl, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on("error", reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      });
      console.log(`[external] HTTP ${statusCode} ${statusCode === 200 ? "OK ✓" : "FAIL"}`);
    } catch (e: unknown) {
      console.log(`[external] ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n=== /healthz: ${healthy ? "200 OK — RUNNING ✓" : "FAILED ✗"} ===`);
  process.exit(healthy ? 0 : 1);
}

main().catch((e: unknown) => { console.error("Fatal:", e); process.exit(1); });
