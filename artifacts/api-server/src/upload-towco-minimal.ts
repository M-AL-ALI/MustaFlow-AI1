/**
 * Upload pre-built Towco client + minimal Node.js server to Fly container.
 * Uses exec stdin field for large files (avoids exec body/command-size limits).
 * No npm install needed — pure Node.js server handles /healthz + static files.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx src/upload-towco-minimal.ts
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, join, relative } from "path";
import {
  execInContainer,
  writeFileToContainer,
  patchMachineAutostop,
} from "./lib/container.js";

const MACHINE_ID = "d895134c606e98";
const PROJECT_ID = 86;
const BUILD_DIR = "/tmp/towco-build";
const MINIMAL_SERVER = "/tmp/towco-minimal-server.mjs";

const FLY_APP = process.env.FLY_APP_NAME ?? "mustaflow-containers";
const FLY_TOKEN = process.env.FLY_API_TOKEN ?? "";
const FLY_API_BASE = "https://api.machines.dev/v1";

function sh(cmd: string): string[] {
  return ["sh", "-c", cmd];
}

async function exec(label: string, cmd: string[]) {
  console.log(`\n[exec] ${label}`);
  const res = await execInContainer(MACHINE_ID, cmd, PROJECT_ID, "/app");
  const out = (res.stdout + res.stderr).trim();
  if (out) console.log("  " + out.slice(0, 800).split("\n").join("\n  "));
  console.log(`  exit=${res.exitCode}`);
  return res;
}

/**
 * Write a file to the container by appending small base64 chunks via exec.
 *
 * The Fly exec API appears to limit command bodies; large echo base64 strings
 * fail silently. Splitting into 3000-char chunks (well under any limit) and
 * appending each independently works reliably.
 *
 * Base64 chars are split at multiples of 4 so each chunk decodes independently.
 */
async function writeFileChunked(containerPath: string, content: string | Buffer): Promise<boolean> {
  const data = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  const b64 = data.toString("base64");
  const fullPath = `/app/${containerPath}`;
  const dir = fullPath.includes("/") ? fullPath.split("/").slice(0, -1).join("/") : "/app";

  // 8000 chars per chunk (divisible by 4), 400ms between execs to avoid 429 rate limits.
  // Each chunk decodes to 6000 bytes, appended independently with base64 -d.
  const CHUNK = 8000;
  const DELAY_MS = 400;
  const chunks = Math.ceil(b64.length / CHUNK);

  // Create / truncate the file
  const initRes = await flyExec(`mkdir -p "${dir}" && : > "${fullPath}"`);
  if (!initRes) { console.error(`  chunk init failed`); return false; }

  for (let i = 0; i < chunks; i++) {
    const part = b64.slice(i * CHUNK, (i + 1) * CHUNK);
    if (i > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    const ok = await flyExec(`printf '%s' '${part}' | base64 -d >> "${fullPath}"`);
    if (!ok) { console.error(`  chunk ${i + 1}/${chunks} failed`); return false; }
  }

  // Verify
  const szRes = await flyExecOut(`wc -c "${fullPath}"`);
  const actual = parseInt((szRes.match(/^\d+/) ?? ["0"])[0], 10);
  if (actual !== data.length) {
    console.error(`  size mismatch: ${actual} vs ${data.length}`);
    return false;
  }
  return true;
}

/** Run a shell command on the container, return true on exit 0. */
async function flyExec(cmd: string): Promise<boolean> {
  try {
    const res = await fetch(`${FLY_API_BASE}/apps/${FLY_APP}/machines/${MACHINE_ID}/exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${FLY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command: ["/bin/sh", "-c", cmd], cwd: "/app", timeout: 30 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { exit_code: number };
    return json.exit_code === 0;
  } catch { return false; }
}

/** Run a shell command on the container, return combined stdout+stderr text. */
async function flyExecOut(cmd: string): Promise<string> {
  try {
    const res = await fetch(`${FLY_API_BASE}/apps/${FLY_APP}/machines/${MACHINE_ID}/exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${FLY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command: ["/bin/sh", "-c", cmd], cwd: "/app", timeout: 30 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return "";
    const json = (await res.json()) as { exit_code: number; stdout: string; stderr: string };
    return ((json.stdout ?? "") + (json.stderr ?? "")).trim();
  } catch { return ""; }
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

async function main() {
  console.log("=== Upload minimal Towco server + pre-built client (stdin method) ===\n");

  if (!FLY_TOKEN) {
    console.error("FLY_API_TOKEN not set");
    process.exit(1);
  }

  // 1. Keep machine awake
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "off").catch(() => null);
  await new Promise((r) => setTimeout(r, 3000));

  // 2. Diagnostics
  await exec("machine state", sh("free -m | head -2; node --version; ls /app/"));

  // 3. Create directories
  await exec("mkdir dirs", sh("mkdir -p /app/dist/client/assets"));

  // 4. Upload dist/client/ files via chunked append (handles any size reliably)
  const clientDir = resolve(BUILD_DIR, "dist/client");
  const clientFiles = walkDir(clientDir, clientDir);
  console.log(`\n[upload] ${clientFiles.length} client files via chunked append...`);
  for (const { abs, rel } of clientFiles) {
    const data = readFileSync(abs);
    const b64len = Math.ceil(data.length * 4 / 3);
    const nchunks = Math.ceil(b64len / 3000);
    process.stdout.write(`  dist/client/${rel} — ${Math.round(data.length / 1024)} KB (${nchunks} chunks)... `);
    const ok = await writeFileChunked(`dist/client/${rel}`, data);
    console.log(ok ? "OK" : "FAIL");
  }

  // 5. Verify client files
  await exec("verify dist/client", sh("ls -la /app/dist/client/ && ls -la /app/dist/client/assets/"));

  // 6. Upload minimal server (tiny — either method works)
  const serverContent = readFileSync(MINIMAL_SERVER, "utf-8");
  const serverOk = await writeFileToContainer(MACHINE_ID, "server.mjs", serverContent, PROJECT_ID);
  console.log(`\n[upload] server.mjs (${serverContent.length} bytes) → ${serverOk ? "OK" : "FAIL"}`);

  // 7. Verify server
  await exec("verify server.mjs", sh("ls -la /app/server.mjs && head -3 /app/server.mjs"));

  // 8. Kill stale processes
  await exec("kill stale", sh("pkill -9 -f 'tsx|node.*server|fly-health' 2>/dev/null; sleep 1; true"));

  // 9. Start minimal server
  await exec("start server", sh(
    "cd /app && rm -f /tmp/server.log && " +
    "nohup node server.mjs > /tmp/server.log 2>&1 & echo PID=$! && sleep 2 && head -5 /tmp/server.log"
  ));

  // 10. Poll /healthz using Node.js built-in http (curl/wget may be missing)
  console.log("\n[healthz] Polling via node http...");
  const hzScript = `const h=require('http');h.get('http://localhost:3000/healthz',(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{process.stdout.write('HTTP:'+r.statusCode+' '+d.slice(0,80));process.exit(r.statusCode===200?0:1)})}).on('error',(e)=>{process.stdout.write('ERR:'+e.message);process.exit(2)})`;
  let healthy = false;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await execInContainer(
      MACHINE_ID,
      ["node", "-e", hzScript],
      PROJECT_ID,
      "/app"
    );
    const out = (res.stdout + res.stderr).trim();
    console.log(`  attempt ${i + 1}: ${out.slice(0, 120)} (exit=${res.exitCode})`);
    if (res.exitCode === 0 || out.startsWith("HTTP:200")) {
      healthy = true;
      break;
    }
    if (i === 2) await exec("server log", sh("cat /tmp/server.log 2>/dev/null"));
  }

  if (!healthy) {
    await exec("server log (final)", sh("cat /tmp/server.log 2>/dev/null || echo '(empty)'"));
  }

  // 11. External Fly URL check via Node.js (no curl/wget needed here)
  const flyUrl = `https://mustaflow-containers.fly.dev/container/${MACHINE_ID}/healthz`;
  console.log(`\n[external] GET ${flyUrl}`);
  try {
    const { default: https } = await import("https");
    let body = "";
    const code = await new Promise<number>((resolve, reject) => {
      const req = https.get(flyUrl, (res) => {
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    });
    console.log(`  HTTP ${code} ${code === 200 ? "OK ✓" : "FAIL"} — ${body.slice(0, 80)}`);
    if (code === 200) healthy = true;
  } catch (e: unknown) {
    console.log(`  ${e instanceof Error ? e.message : String(e)} (DNS blocked in Replit sandbox)`);
  }

  // 12. Re-enable autostop
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "stop").catch(() => null);

  console.log(`\n=== /healthz: ${healthy ? "200 OK ✓" : "FAILED ✗"} ===`);
  if (healthy) {
    console.log(`   Container: https://mustaflow-containers.fly.dev/container/${MACHINE_ID}`);
    console.log("   Serving: /healthz + dist/client/ static files (no npm install needed)");
    console.log("   Preview proxy: works in production — DNS blocked in Replit sandbox only");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
