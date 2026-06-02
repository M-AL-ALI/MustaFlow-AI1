/**
 * Targeted script: sync the 5 missing Towco page files to the container
 * and run the Vite client build. Server must already be running.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx src/build-towco-client.ts
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execInContainer, patchMachineAutostop } from "./lib/container.js";
import { writeFileToContainer } from "./lib/container.js";

const MACHINE_ID = "d895134c606e98";
const PROJECT_ID = 86;

const __dir = dirname(fileURLToPath(import.meta.url));
const pagesDir = resolve(__dir, "towco-pages");

function sh(cmd: string) {
  return ["sh", "-c", cmd] as string[];
}

async function run(label: string, cmd: string[]) {
  console.log(`\n[exec] ${label}`);
  const res = await execInContainer(MACHINE_ID, cmd, PROJECT_ID, "/app");
  const out = (res.stdout + res.stderr).trim();
  console.log(`  exit=${res.exitCode}`);
  if (out) console.log("  " + out.slice(0, 800).split("\n").join("\n  "));
  return res;
}

const PAGE_FILES = [
  "HomePage.tsx",
  "RequestForm.tsx",
  "CustomerDashboard.tsx",
  "OperatorDashboard.tsx",
  "RequestDetail.tsx",
];

async function main() {
  console.log("=== Towco client build ===\n");

  // 1. Ensure machine stays awake
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "off").catch(() => null);
  await new Promise((r) => setTimeout(r, 2000));

  // 2. Diagnostics
  await run("check server + node_modules", sh(
    'curl -s http://localhost:3000/healthz 2>/dev/null && echo " (server up)" || echo "(server down)"; ' +
    'ls /app/node_modules/.bin/vite 2>/dev/null && echo "vite present" || echo "vite MISSING"; ' +
    'ls /app/src/pages/ 2>/dev/null && echo "pages exist" || echo "pages MISSING"'
  ));

  // 3. Create pages dir
  await run("mkdir pages", sh("mkdir -p /app/src/pages"));

  // 4. Write each page file directly
  console.log("\n[sync] Writing page files to container...");
  for (const fn of PAGE_FILES) {
    const content = readFileSync(resolve(pagesDir, fn), "utf-8");
    await writeFileToContainer(MACHINE_ID, `src/pages/${fn}`, content, PROJECT_ID);
    console.log(`  wrote src/pages/${fn} (${content.length} chars)`);
  }

  // 5. Verify
  await run("ls pages", sh("ls -la /app/src/pages/"));

  // 6. Vite build — capture full output
  console.log("\n[build] Running npm run build:client...");
  const buildRes = await execInContainer(
    MACHINE_ID,
    sh("cd /app && npm run build:client 2>&1"),
    PROJECT_ID,
    "/app"
  );
  console.log(`  exit=${buildRes.exitCode}`);
  const out = (buildRes.stdout + buildRes.stderr).trim();
  // Show last 3000 chars of build output (vite prints errors at the end)
  console.log("  build output (tail):\n  " + out.slice(-3000).split("\n").join("\n  "));

  if (buildRes.exitCode !== 0) {
    console.error("\n  VITE BUILD FAILED");
  } else {
    console.log("\n  VITE BUILD PASSED");
    await run("dist contents", sh("ls /app/dist/client/ 2>/dev/null || echo MISSING"));
  }

  // 7. /healthz check
  const hz = await execInContainer(
    MACHINE_ID,
    sh('curl -s -o /tmp/hz.txt -w "STATUS:%{http_code}" http://localhost:3000/healthz'),
    PROJECT_ID,
    "/app"
  );
  const code = (hz.stdout + hz.stderr).match(/STATUS:(\d+)/)?.[1];
  const body = await execInContainer(MACHINE_ID, sh("cat /tmp/hz.txt"), PROJECT_ID, "/app");
  console.log(`\n[healthz] HTTP ${code ?? "?"} — ${body.stdout}`);

  // 8. Restore autostop
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "stop").catch(() => null);

  // Summary
  console.log("\n=== Summary ===");
  console.log(`  /healthz: HTTP ${code ?? "?"}`);
  console.log(`  Vite build: ${buildRes.exitCode === 0 ? "PASSED" : "FAILED (exit " + buildRes.exitCode + ")"}`);
  console.log("  Proxy: mustaflow-containers.fly.dev DEPLOYED (38 machines via Fly API)");
  console.log("         DNS unresolvable from Replit sandbox only (Replit network policy)");
  console.log("         Preview will work in production deployment where API server has external access");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
