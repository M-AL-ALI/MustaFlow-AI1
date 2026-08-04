/**
 * Uploads the pre-built Towco dist (built locally in /tmp/towco-build) to
 * the Fly container, then starts the server with plain `node`.
 * No npm install needed on the resource-constrained machine.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx src/upload-towco-dist.ts
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, join, relative } from "path";
import {
  execInContainer,
  writeFileToContainer,
  patchMachineAutostop,
  tenantRuntimeProvider,
} from "./lib/tenant-runtime.js";

const MACHINE_ID = "d895134c606e98";
const PROJECT_ID = 86;
const BUILD_DIR = "/tmp/towco-build";

// Max text chars per chunk — ~140KB text → ~187KB UTF-8 base64 → safely under exec API limit.
// The 201KB JS file (268KB base64) uploaded fine, so this is conservative.
const CHUNK_CHARS = 140_000;

function sh(cmd: string): string[] {
  return ["sh", "-c", cmd];
}

async function exec(
  label: string,
  cmd: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number; output: string }> {
  console.log(`\n[exec] ${label}`);
  const res = await execInContainer(MACHINE_ID, cmd, PROJECT_ID, "/app");
  const out = (res.stdout + res.stderr).trim();
  if (out) console.log("  " + out.slice(0, 600).split("\n").join("\n  "));
  console.log(`  exit=${res.exitCode}`);
  return { ...res, output: out };
}

function walkDir(dir: string, base: string): Array<{ abs: string; rel: string }> {
  const results: Array<{ abs: string; rel: string }> = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = relative(base, abs);
    if (statSync(abs).isDirectory()) {
      results.push(...walkDir(abs, base));
    } else {
      results.push({ abs, rel });
    }
  }
  return results;
}

async function uploadLargeText(containerPath: string, text: string) {
  const totalChunks = Math.ceil(text.length / CHUNK_CHARS);
  console.log(
    `  chunking ${containerPath} (${Math.round(text.length / 1024)} KB text) into ${totalChunks} parts...`,
  );

  const chunkPaths: string[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunk = text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
    const chunkPath = `${containerPath}.part${i}`;
    const ok = await writeFileToContainer(MACHINE_ID, chunkPath, chunk, PROJECT_ID);
    console.log(`  part ${i + 1}/${totalChunks}: ${chunk.length} chars → ${ok ? "OK" : "FAIL"}`);
    chunkPaths.push(`/app/${chunkPath}`);
  }

  // Concatenate parts into final file
  const catCmd = `cat ${chunkPaths.join(" ")} > /app/${containerPath} && rm -f ${chunkPaths.join(" ")} && echo CAT_OK`;
  const catRes = await exec(`cat ${totalChunks} parts → ${containerPath}`, sh(catCmd));
  if (!catRes.output.includes("CAT_OK")) {
    console.error(`  cat failed: ${catRes.output}`);
    return false;
  }
  const sizeRes = await exec(`verify ${containerPath}`, sh(`wc -c /app/${containerPath}`));
  const actual = parseInt((sizeRes.output.match(/^\d+/) ?? ["0"])[0], 10);
  console.log(`  verified: ${actual} bytes (expected ~${text.length})`);
  return actual > 0;
}

async function main() {
  console.log("=== Upload pre-built Towco dist to container ===\n");

  // 1. Keep machine awake
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "off").catch(() => null);
  await new Promise((r) => setTimeout(r, 3000));

  // 2. Diagnostics
  await exec("machine state", sh("free -m | head -2; node --version"));

  // 3. Create directories
  await exec("mkdir dirs", sh("mkdir -p /app/dist/client/assets /app/dist/server"));

  // 4. Upload dist/client/ files (small — fit in single exec)
  const clientDir = resolve(BUILD_DIR, "dist/client");
  const clientFiles = walkDir(clientDir, clientDir);
  console.log(`\n[upload] Uploading ${clientFiles.length} client files...`);
  for (const { abs, rel } of clientFiles) {
    const data = readFileSync(abs);
    await writeFileToContainer(
      MACHINE_ID,
      `dist/client/${rel}`,
      data.toString("utf-8"),
      PROJECT_ID,
    );
    console.log(`  dist/client/${rel} (${Math.round(data.length / 1024)} KB)`);
  }

  // 5. Upload server bundle (large — split as text chunks then cat together)
  const serverText = readFileSync(resolve(BUILD_DIR, "dist/server.min.mjs"), "utf-8");
  console.log(`\n[upload] Server bundle: ${Math.round(serverText.length / 1024)} KB`);
  const serverOk = await uploadLargeText("dist/server.mjs", serverText);
  if (!serverOk) {
    console.error("Server bundle upload failed!");
    process.exit(1);
  }

  // 6. Kill stale processes
  await exec("kill stale", sh("pkill -9 -f 'tsx|server|fly-health' 2>/dev/null; sleep 1; true"));

  // 7. Start server
  await exec(
    "start server",
    sh(
      "cd /app && rm -f /tmp/server.log && " +
        "nohup node dist/server.mjs > /tmp/server.log 2>&1 & echo PID=$!",
    ),
  );

  // 8. Poll /healthz (up to 60s)
  console.log("\n[healthz] Polling...");
  let healthy = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await execInContainer(
      MACHINE_ID,
      sh("curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/healthz"),
      PROJECT_ID,
      "/app",
    );
    const code = (res.stdout + res.stderr).trim();
    console.log(`  attempt ${i + 1}: HTTP ${code}`);
    if (code === "200") {
      healthy = true;
      break;
    }
    if (i === 2) await exec("server log", sh("tail -20 /tmp/server.log 2>/dev/null"));
  }

  if (!healthy) {
    await exec("server log (final)", sh("tail -40 /tmp/server.log 2>/dev/null || echo '(empty)'"));
  }

  // 9. Verify dist/client
  await exec("dist contents", sh("ls /app/dist/client/ && ls /app/dist/client/assets/"));

  // 10. External URL test
  if (healthy) {
    const flyUrl = `${tenantRuntimeProvider.resolveEndpoint(MACHINE_ID)}/healthz`;
    console.log(`\n[external] GET ${flyUrl}`);
    try {
      const { default: https } = await import("https");
      const code = await new Promise<number>((resolve, reject) => {
        const req = https.get(flyUrl, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.setTimeout(15000, () => {
          req.destroy();
          reject(new Error("timeout"));
        });
      });
      console.log(`[external] HTTP ${code} ${code === 200 ? "OK ✓" : "FAIL"}`);
    } catch (e: unknown) {
      console.log(`[external] ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 11. Re-enable autostop
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "stop").catch(() => null);

  console.log(`\n=== Result: ${healthy ? "/healthz 200 OK ✓" : "FAILED ✗"} ===`);
  if (healthy) {
    console.log(`   Container: ${tenantRuntimeProvider.resolveEndpoint(MACHINE_ID)}`);
    console.log(
      "   Preview proxy: works in production deployment (DNS blocked from Replit sandbox)",
    );
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
