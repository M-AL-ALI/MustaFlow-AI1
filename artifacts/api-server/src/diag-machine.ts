/**
 * Diagnostic: check $PORT, listening processes, and Fly services config
 * on the test machine (865990ce734128 / project 82).
 *
 * Usage: pnpm --filter @workspace/api-server exec tsx src/diag-machine.ts
 */

import { execInContainer, getContainerStatus } from "./lib/container.js";

const MACHINE_ID = "865990ce734128";
const PROJECT_ID = 82;
const FLY_APP = process.env.FLY_APP_NAME ?? "mustaflow-containers";
const FLY_TOKEN = process.env.FLY_API_TOKEN ?? "";

// ── 1. Machine state via API ─────────────────────────────────────────────────
const state = await getContainerStatus(MACHINE_ID);
console.log(`\n[machine state] ${state}`);

// ── 2. Fly services config (raw GET) ────────────────────────────────────────
const machineRes = await fetch(
  `https://api.machines.dev/v1/apps/${FLY_APP}/machines/${MACHINE_ID}`,
  { headers: { Authorization: `Bearer ${FLY_TOKEN}` } },
);
const machineJson = (await machineRes.json()) as {
  state?: string;
  config?: { services?: unknown; env?: Record<string, string> };
};
console.log("\n[fly services config]");
console.log(JSON.stringify(machineJson.config?.services ?? [], null, 2));
console.log("\n[fly env PORT from config]", machineJson.config?.env?.["PORT"] ?? "(not set)");

// ── 3. In-machine: $PORT, listening processes, health server ─────────────────
if (state === "running") {
  const r = await execInContainer(
    MACHINE_ID,
    [
      "sh",
      "-c",
      [
        "echo === PORT ===$PORT",
        "echo === listening processes ===",
        "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo '(ss/netstat not available)'",
        "echo === node processes ===",
        "ps aux | grep node | grep -v grep || echo '(none)'",
        "echo === health-server proc ===",
        "ps aux | grep fly-health-server | grep -v grep || echo '(none)'",
      ].join(" ; "),
    ],
    PROJECT_ID,
  );
  console.log("\n[in-machine exec exit code]", r.exitCode);
  console.log("[stdout]", r.stdout);
  if (r.stderr) console.log("[stderr]", r.stderr);
} else {
  console.log(`\n[skipping in-machine exec — machine is ${state}]`);
}

// ── 4. Reachability: probe the machine proxy URL from here ───────────────────
const proxyBase = `https://${FLY_APP}.fly.dev/container/${MACHINE_ID}`;
console.log(`\n[probe] ${proxyBase}/healthz`);
try {
  const r = await fetch(`${proxyBase}/healthz`, {
    signal: AbortSignal.timeout(6_000),
    headers: { "fly-force-instance-id": MACHINE_ID },
  });
  console.log(`  → HTTP ${r.status}`);
} catch (e: unknown) {
  console.log(`  → fetch error: ${e instanceof Error ? e.message : String(e)}`);
}

// Also probe the bare app URL (no /container prefix) to check Fly routing
const bareUrl = `https://${FLY_APP}.fly.dev/healthz`;
console.log(`\n[probe bare] ${bareUrl}`);
try {
  const r2 = await fetch(bareUrl, {
    signal: AbortSignal.timeout(6_000),
    headers: { "fly-force-instance-id": MACHINE_ID },
  });
  console.log(`  → HTTP ${r2.status}`);
} catch (e: unknown) {
  console.log(`  → fetch error: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("\n[done]");
